import assert from 'node:assert/strict';
import { test } from 'node:test';
import { InvocationQueue } from '../dist/domains/cats/services/agents/invocation/InvocationQueue.js';
import { hydrateQueueLedgerEntry } from '../dist/domains/cats/services/agents/invocation/queue-ledger/RedisQueueLedgerCodec.js';
import { RedisQueueLedgerStore } from '../dist/domains/cats/services/agents/invocation/queue-ledger/RedisQueueLedgerStore.js';
import { RedisMessageStore } from '../dist/domains/cats/services/stores/redis/RedisMessageStore.js';
import { ownedRedisFixture } from './helpers/owned-redis-fixture.js';

const owned = ownedRedisFixture('f117-empty-request-targets');

async function admit(prefix) {
  const redis = owned.client(prefix);
  const ledger = new RedisQueueLedgerStore(redis);
  const messages = new RedisMessageStore(redis, { ttlSeconds: 0 });
  const queue = new InvocationQueue(ledger, { resolveTargets: async () => ['opus'] });
  const from = { kind: 'user', userId: 'owner' };
  const message = {
    from,
    threadId: 'thread',
    userId: 'owner',
    content: 'plain message',
    mentions: [],
    deliveryStatus: 'queued',
    timestamp: 100,
    idempotencyKey: 'request',
  };
  const input = {
    from,
    threadId: 'thread',
    userId: 'owner',
    content: message.content,
    targetCats: [],
    intent: 'execute',
    kind: 'conversation_input',
    ownerAuthProvenance: 'strict',
  };
  const accepted = await queue.send(messages, message, input);
  assert.deepEqual(accepted.entry.targets, ['opus']);
  return { redis, ledger, messages, queue, message, input, entry: await ledger.get('thread', accepted.entry.id) };
}

test('Redis claim and restore retain an empty requested-target snapshot and same-ID replay', async () => {
  const { redis, ledger, queue, messages, message, input, entry } = await admit('single:');
  const claim = await ledger.claim('thread', entry.id, 'claim', 200, 'opus');
  assert.equal(claim.outcome, 'claimed');
  assert.deepEqual(claim.entries[0].payload.requestedTargetCats, []);
  assert.deepEqual(JSON.parse(await redis.hget('queue:{thread}:entries', entry.id)).payload.requestedTargetCats, []);
  assert.equal((await ledger.restore('thread', entry.id, 'claim')).outcome, 'updated');
  assert.deepEqual((await ledger.get('thread', entry.id)).payload.requestedTargetCats, []);
  const replay = await queue.send(messages, message, input);
  assert.equal(replay.deduped, true);
  assert.equal(replay.entry.id, entry.id);
  await ledger.claim('thread', entry.id, 'execute-claim', 201, 'opus');
  const executeLua = redis.eval.bind(redis);
  let transitionReply;
  redis.eval = async (...args) => {
    transitionReply = await executeLua(...args);
    return transitionReply;
  };
  assert.equal((await ledger.commit('thread', entry.id, 'execute-claim', 'processing', 202)).outcome, 'updated');
  assert.deepEqual(JSON.parse(transitionReply[1]).payload.requestedTargetCats, []);
  assert.equal(await ledger.get('thread', entry.id), null, 'accepted execution retires the pending row');
});

test('Redis prefix claims preserve empty requested-target snapshots', async () => {
  const { redis, ledger, entry } = await admit('prefix:');
  const claim = await ledger.claimPrefix('thread', [entry.id], 'prefix-claim', 200, 'opus');
  assert.equal(claim.outcome, 'claimed');
  assert.deepEqual(claim.entries[0].payload.requestedTargetCats, []);
  assert.deepEqual(JSON.parse(await redis.hget('queue:{thread}:entries', entry.id)).payload.requestedTargetCats, []);
});

test('Redis target reconciliation and expansion preserve the original request snapshot', async () => {
  const { redis, ledger, entry } = await admit('targets:');
  const reconciled = await ledger.reconcileTargets('thread', entry.id, ['codex'], []);
  assert.equal(reconciled.outcome, 'updated');
  assert.deepEqual(reconciled.entry.payload.requestedTargetCats, []);
  assert.deepEqual(JSON.parse(await redis.hget('queue:{thread}:entries', entry.id)).payload.requestedTargetCats, []);
  const expanded = await ledger.expandTargets('thread', entry.id, 'sonnet', [entry.id], []);
  assert.equal(expanded.outcome, 'expanded');
  assert.deepEqual(expanded.entries[0].payload.requestedTargetCats, []);
  assert.deepEqual(JSON.parse(await redis.hget('queue:{thread}:entries', entry.id)).payload.requestedTargetCats, []);
});

test('already persisted Lua empty-object snapshots remain readable and restorable without deleting rows', async () => {
  const { redis, ledger, entry } = await admit('recovery:');
  const damaged = {
    ...entry,
    status: 'claimed',
    claimId: 'old-claim',
    claimedAt: 200,
    claimedTargetIds: ['opus'],
    payload: { ...entry.payload, requestedTargetCats: {} },
  };
  await redis.hset('queue:{thread}:entries', entry.id, JSON.stringify(damaged));
  assert.deepEqual((await ledger.get('thread', entry.id)).payload.requestedTargetCats, []);
  assert.equal((await ledger.restore('thread', entry.id, 'old-claim')).outcome, 'updated');
  assert.equal((await ledger.list('thread')).length, 1);
  assert.deepEqual((await ledger.get('thread', entry.id)).payload.requestedTargetCats, []);
  assert.deepEqual(JSON.parse(await redis.hget('queue:{thread}:entries', entry.id)).payload.requestedTargetCats, []);
});

test('codec recovery does not accept malformed nonempty or null requested-target objects', async () => {
  const { entry } = await admit('invalid:');
  for (const requestedTargetCats of [{ opus: true }, null, 'opus']) {
    assert.throws(
      () => hydrateQueueLedgerEntry(JSON.stringify({ ...entry, payload: { ...entry.payload, requestedTargetCats } })),
      /queue ledger targets are invalid/,
    );
  }
});
