import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { InvocationQueue } from '../dist/domains/cats/services/agents/invocation/InvocationQueue.js';
import { QueueLedgerKeys } from '../dist/domains/cats/services/agents/invocation/queue-ledger/queue-ledger-keys.js';
import { RedisQueueLedgerStore } from '../dist/domains/cats/services/agents/invocation/queue-ledger/RedisQueueLedgerStore.js';
import { RedisMessageStore } from '../dist/domains/cats/services/stores/redis/RedisMessageStore.js';
import { appendRecoveryFixture, recoveryProcessor } from './helpers/append-recovery-fixture.js';
import { ownedRedisFixture } from './helpers/owned-redis-fixture.js';

const owned = ownedRedisFixture('history-append-1827');
async function fixture(dispatch, options = {}) {
  const client = owned.client(`${randomUUID()}:`);
  const store = new RedisMessageStore(client, { ttlSeconds: 0 });
  const ledger = new RedisQueueLedgerStore(client);
  const f = await appendRecoveryFixture(dispatch, { messageStore: store, ledgerStore: ledger, ...options });
  return { ...f, client, store, ledger };
}

test('Redis History owns a pending provider write and survives reopening with no Queue target', async () => {
  let release;
  let entered;
  let calls = 0;
  const handoff = new Promise((resolve) => {
    entered = resolve;
  });
  const f = await fixture(() => {
    calls++;
    entered();
    return new Promise((resolve) => {
      release = resolve;
    });
  });
  const appending = f.append();
  await handoff;
  try {
    const reopened = new RedisMessageStore(f.client, { ttlSeconds: 0 });
    assert.equal(await f.ledger.get('thread', f.admission.entry.id), null);
    assert.equal(
      (await reopened.getById(f.admission.message.id)).lifecycle.dispatchRefs[0].appendAcceptance,
      'pending',
    );
    assert.deepEqual(await reopened.listUnresolvedAppendThreadIds(), ['thread']);
    assert.equal((await reopened.listUnresolvedAppendMessages('thread'))[0].id, f.admission.message.id);
    assert.equal(await f.client.ttl(`msg:${f.admission.message.id}`), -1);
  } finally {
    release({ accepted: false, reason: 'exception', acceptance: 'unknown' });
    await appending;
    await f.processor.reconcileAppendDeliveries('thread');
  }
  assert.equal(calls, 1);
  assert.equal(await f.ledger.get('thread', f.admission.entry.id), null);
});

test('Redis lost refusal-transaction reply replays one pending target and keeps a sibling claim', async () => {
  const f = await fixture(async () => ({ accepted: false, reason: 'active_run_closed', acceptance: 'not_accepted' }));
  await f.queue.reconcileQueuedMessageTargetsDurable('thread', 'owner', f.admission.entry.id, ['codex'], [], {});
  const commit = f.store.commitLifecycleAppendRecovery.bind(f.store);
  let lost = false;
  f.store.commitLifecycleAppendRecovery = async (input, ledger) => {
    if (!lost) {
      lost = true;
      assert.equal(
        (await f.ledger.claim('thread', f.admission.entry.id, 'sibling', Date.now(), 'codex')).outcome,
        'claimed',
      );
      await commit(input, ledger);
      throw new Error('lost transaction reply');
    }
    return commit(input, ledger);
  };
  await f.append();
  const row = await f.ledger.get('thread', f.admission.entry.id);
  assert.deepEqual(new Set(row.targets), new Set(['opus', 'codex']));
  assert.deepEqual(row.claimedTargetIds, ['codex']);
  assert.equal(row.claimId, 'sibling');
  assert.equal(row.delivery.authorIntentByTarget.opus.requested, 'next_work');
  assert.equal(row.delivery.appendRecoveryByTarget, undefined);
  const source = await f.store.getById(f.admission.message.id);
  assert.deepEqual(source.lifecycle.dispatchRefs, []);
  assert.equal(source.lifecycle.appendFailures.length, 1);
  assert.equal((await f.client.lrange(QueueLedgerKeys.order('thread'), 0, -1)).filter((id) => id === row.id).length, 1);
});

test('Redis outcome-write outage recovers from History after a fresh store and tracker without resending', async () => {
  let calls = 0;
  const f = await fixture(async () => {
    calls++;
    return { accepted: false, reason: 'exception', acceptance: 'unknown' };
  });
  f.store.commitLifecycleAppendRecovery = async () => {
    throw new Error('storage outage');
  };
  await f.append();
  await f.processor.reconcileAppendDeliveries('thread');
  assert.equal(await f.ledger.get('thread', f.admission.entry.id), null);
  const reopened = new RedisMessageStore(f.client, { ttlSeconds: 0 });
  const queue = new InvocationQueue(new RedisQueueLedgerStore(f.client));
  await queue.hydrateFromLedger(reopened);
  const restarted = recoveryProcessor({ queue, messageStore: reopened });
  await restarted.reconcileAppendDeliveries('thread');
  const source = await reopened.getById(f.admission.message.id);
  assert.equal(source.lifecycle.appendFailures[0].acceptance, 'unknown');
  assert.ok(source.lifecycle.appendFailures[0].checkedAt);
  assert.equal(source.lifecycle.dispatchRefs[0].statusMessageId, f.response.id);
  assert.equal(calls, 1);
  assert.deepEqual(await reopened.listUnresolvedAppendThreadIds(), []);
  assert.deepEqual(queue.list('thread', 'owner'), []);
});

test('legacy native Queue facts migrate to History before removing only the handed-over target', async () => {
  const f = await fixture(async () => ({ accepted: true }), { inputCompletionReceipt: true });
  await f.append();
  const lifecycle = JSON.parse(await f.client.hget(`msg:${f.admission.message.id}`, 'lifecycle'));
  delete lifecycle.dispatchRefs[0].appendDelivery;
  await f.client.hset(`msg:${f.admission.message.id}`, 'lifecycle', JSON.stringify(lifecycle));
  await f.client.del('msg:append-pending:thread', 'msg:append-pending-threads');
  const legacy = structuredClone(f.admission.entry);
  legacy.targets = ['opus', 'codex'];
  legacy.delivery.appendPendingByTarget = {
    opus: {
      targetId: 'opus',
      invocationId: 'turn',
      responseMessageId: f.response.id,
      at: Date.now(),
      dispatchStarted: true,
      requiresCompletion: true,
    },
  };
  legacy.delivery.routingHeldTargetIds = ['opus'];
  await f.ledger.enqueue([legacy]);
  const reopened = new RedisMessageStore(f.client, { ttlSeconds: 0 });
  const queue = new InvocationQueue(new RedisQueueLedgerStore(f.client));
  await queue.hydrateFromLedger(reopened);
  assert.deepEqual((await f.ledger.get('thread', legacy.id)).targets, ['codex']);
  assert.equal(
    (await reopened.getById(f.admission.message.id)).lifecycle.dispatchRefs[0].appendDelivery.requiresCompletion,
    true,
  );
  assert.deepEqual(await reopened.listUnresolvedAppendThreadIds(), ['thread']);
  const restarted = recoveryProcessor({ queue, messageStore: reopened });
  await restarted.reconcileAppendDeliveries('thread');
  assert.equal((await reopened.getById(f.admission.message.id)).lifecycle.appendFailures[0].acceptance, 'incomplete');
  assert.deepEqual((await f.ledger.get('thread', legacy.id)).targets, ['codex']);
});

test('Redis late read wins over a negative probe and cannot create a second Queue attempt', async () => {
  let inputRead;
  let calls = 0;
  const f = await fixture(
    async (input) => {
      calls++;
      inputRead = input.onInputRead;
      return { accepted: false, reason: 'exception', acceptance: 'unknown' };
    },
    {
      inspectInput: async () => {
        await inputRead();
        return 'not_accepted';
      },
    },
  );
  await f.append();
  await f.processor.reconcileAppendDeliveries('thread');
  const source = await f.store.getById(f.admission.message.id);
  assert.equal(source.lifecycle.dispatchRefs[0].inputRead.status, 'read');
  assert.equal(source.lifecycle.appendFailures[0].acceptance, 'unknown');
  assert.equal(await f.ledger.get('thread', f.admission.entry.id), null);
  assert.equal(calls, 1);
});

test('legacy definite refusal keeps pending scope but changes the next attempt to next_work', async () => {
  const f = await fixture(async () => ({ accepted: false, reason: 'active_run_closed', acceptance: 'not_accepted' }));
  await f.append();
  const source = await f.store.getById(f.admission.message.id);
  const legacy = await f.ledger.get('thread', f.admission.entry.id);
  legacy.delivery.appendRecoveryByTarget = { opus: source.lifecycle.appendFailures[0] };
  legacy.delivery.authorIntentByTarget.opus.requested = 'continue_current';
  const key = QueueLedgerKeys.entries('thread');
  await f.client.hset(key, legacy.id, JSON.stringify(legacy));
  const queue = new InvocationQueue(new RedisQueueLedgerStore(f.client));
  assert.equal(await queue.hydrateFromLedger(f.store), 1);
  const row = await f.ledger.get('thread', legacy.id);
  assert.deepEqual(row.targets, ['opus']);
  assert.equal(row.delivery.authorIntentByTarget.opus.requested, 'next_work');
  assert.deepEqual(row.execution, legacy.execution);
  assert.equal(row.delivery.appendRecoveryByTarget, undefined);
  assert.deepEqual((await f.store.getById(source.id)).lifecycle, source.lifecycle);
});
