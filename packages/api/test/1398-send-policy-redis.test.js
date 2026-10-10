import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { saveMessageDispositionPreference } from '../dist/config/user-preferences-store.js';
import { InvocationQueue } from '../dist/domains/cats/services/agents/invocation/InvocationQueue.js';
import { RedisQueueLedgerStore } from '../dist/domains/cats/services/agents/invocation/queue-ledger/RedisQueueLedgerStore.js';
import { RedisMessageStore } from '../dist/domains/cats/services/stores/redis/RedisMessageStore.js';
import { ownedRedisFixture } from './helpers/owned-redis-fixture.js';

const owned = ownedRedisFixture('f117-send-policy');
test('Redis concurrent source replay and reload keep the winning admission policy', async (t) => {
  const projectRoot = await mkdtemp(join(tmpdir(), 'f117-redis-policy-'));
  t.after(() => rm(projectRoot, { recursive: true, force: true }));
  const redis = owned.client('send-policy:');
  const ledger = new RedisQueueLedgerStore(redis);
  const messages = new RedisMessageStore(redis, { ttlSeconds: 0 });
  const queue = new InvocationQueue(ledger, { projectRoot });
  const from = { kind: 'user', userId: 'owner' };
  const message = {
    threadId: 'thread',
    userId: 'owner',
    from,
    content: 'same immutable body',
    mentions: ['opus'],
    deliveryStatus: 'queued',
    timestamp: 100,
    idempotencyKey: 'policy-request',
  };
  const input = {
    threadId: 'thread',
    userId: 'owner',
    from,
    content: message.content,
    kind: 'conversation_input',
    ownerAuthProvenance: 'strict',
    targetCats: ['opus'],
    intent: 'execute',
  };
  const first = await queue.send(messages, message, input);
  assert.equal(first.entry.delivery.authorIntentByTarget.opus.requested, 'next_work');
  saveMessageDispositionPreference(projectRoot, { scope: 'global', disposition: 'continue_current' });
  const replays = await Promise.all(Array.from({ length: 12 }, () => queue.send(messages, message, input)));
  for (const replay of replays) {
    assert.equal(replay.message.id, first.message.id);
    assert.equal(replay.deduped, true);
    assert.deepEqual(replay.entry.delivery.authorIntentByTarget, first.entry.delivery.authorIntentByTarget);
  }
  assert.equal((await ledger.list('thread')).length, 1);
  const reloaded = new InvocationQueue(new RedisQueueLedgerStore(redis), { projectRoot });
  const replay = await reloaded.send(new RedisMessageStore(redis, { ttlSeconds: 0 }), message, input);
  assert.deepEqual(replay.entry.delivery.authorIntentByTarget, first.entry.delivery.authorIntentByTarget);
  const next = await reloaded.send(messages, { ...message, idempotencyKey: 'independent-request' }, input);
  assert.notEqual(next.message.id, first.message.id);
  assert.equal(next.entry.delivery.authorIntentByTarget.opus.requested, 'continue_current');
  assert.equal(next.entry.delivery.authorIntentByTarget.opus.fallbackReason, 'carrier_capability_undeclared');
  assert.equal((await ledger.list('thread')).length, 2);
  assert.equal(await redis.ttl(`msg:${first.message.id}`), -1);
});

test('Redis default target snapshot survives concurrent admission, fallback changes and reload', async () => {
  const redis = owned.client('target-replay:');
  const ledger = new RedisQueueLedgerStore(redis);
  const messages = new RedisMessageStore(redis, { ttlSeconds: 0 });
  let fallback = 'opus';
  const policy = { resolveTargets: async () => [fallback] };
  const queue = new InvocationQueue(ledger, policy);
  const from = { kind: 'user', userId: 'owner' };
  const message = {
    threadId: 'thread',
    userId: 'owner',
    from,
    content: 'hello',
    mentions: [],
    deliveryStatus: 'queued',
    timestamp: 100,
    idempotencyKey: 'target-request',
  };
  const input = {
    threadId: 'thread',
    userId: 'owner',
    from,
    content: 'hello',
    kind: 'conversation_input',
    ownerAuthProvenance: 'strict',
    targetCats: [],
    intent: 'execute',
  };
  const winners = await Promise.all(Array.from({ length: 12 }, () => queue.send(messages, message, input)));
  const first = winners[0];
  assert.ok(winners.every((result) => result.message.id === first.message.id));
  fallback = 'codex';
  const reloaded = new InvocationQueue(new RedisQueueLedgerStore(redis), policy);
  const retry = await reloaded.send(new RedisMessageStore(redis, { ttlSeconds: 0 }), message, input);
  assert.deepEqual(retry.entry.targets, ['opus']);
  assert.deepEqual(retry.entry.delivery.authorIntentByTarget, first.entry.delivery.authorIntentByTarget);
  await assert.rejects(
    reloaded.send(messages, { ...message, content: 'different' }, { ...input, content: 'different' }),
    /identity conflict/,
  );
  await assert.rejects(reloaded.send(messages, message, { ...input, targetCats: ['codex'] }), /identity conflict/);
  const next = await reloaded.send(messages, { ...message, idempotencyKey: 'next-source' }, input);
  assert.deepEqual(next.entry.targets, ['codex']);
  assert.equal((await ledger.list('thread')).length, 2);
  assert.equal(await redis.ttl(`msg:${first.message.id}`), -1);
});

test('Redis whisper replay and reload retain authorized recipients without ordinary fallback', async () => {
  const redis = owned.client('whisper-replay:');
  const ledger = new RedisQueueLedgerStore(redis);
  const messages = new RedisMessageStore(redis, { ttlSeconds: 0 });
  const policy = { resolveTargets: async (targets, _thread, _body, exact) => (exact ? [...targets] : ['codex']) };
  const queue = new InvocationQueue(ledger, policy);
  const from = { kind: 'user', userId: 'owner' };
  const message = {
    from,
    userId: 'owner',
    threadId: 'whisper-thread',
    content: 'private Redis source',
    mentions: ['opus'],
    visibility: 'whisper',
    whisperTo: ['opus'],
    deliveryStatus: 'queued',
    timestamp: 100,
    idempotencyKey: 'whisper-request',
  };
  const input = {
    from,
    userId: 'owner',
    threadId: 'whisper-thread',
    content: message.content,
    kind: 'conversation_input',
    ownerAuthProvenance: 'strict',
    targetCats: ['opus'],
    intent: 'execute',
  };
  const results = await Promise.all(Array.from({ length: 6 }, () => queue.send(messages, message, input)));
  assert.ok(results.every((result) => result.message.id === results[0].message.id));
  assert.ok(results.every((result) => result.entry.targets.length === 1 && result.entry.targets[0] === 'opus'));
  const reloaded = new InvocationQueue(new RedisQueueLedgerStore(redis), policy);
  const replay = await reloaded.send(new RedisMessageStore(redis, { ttlSeconds: 0 }), message, input);
  assert.deepEqual(replay.entry.targets, ['opus']);
  assert.deepEqual(replay.message.whisperTo, ['opus']);
  await assert.rejects(reloaded.send(messages, message, { ...input, targetCats: ['codex'] }), /authorized recipients/);
  await assert.rejects(
    reloaded.send(
      messages,
      { ...message, whisperTo: ['codex'], mentions: ['codex'] },
      { ...input, targetCats: ['codex'] },
    ),
    /identity conflict/,
  );
  assert.equal((await ledger.list('whisper-thread')).length, 1);
  assert.equal(await redis.ttl(`msg:${results[0].message.id}`), -1);
});
