import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { InvocationQueue } from '../dist/domains/cats/services/agents/invocation/InvocationQueue.js';
import { RedisQueueLedgerStore } from '../dist/domains/cats/services/agents/invocation/queue-ledger/RedisQueueLedgerStore.js';
import { RedisMessageStore } from '../dist/domains/cats/services/stores/redis/RedisMessageStore.js';
import { appendRecoveryFixture, recoveryProcessor } from './helpers/append-recovery-fixture.js';
import { ownedRedisFixture } from './helpers/owned-redis-fixture.js';

const owned = ownedRedisFixture('append-completion');

async function fixture(acceptance = 'accepted') {
  const client = owned.client(`case:${randomUUID()}:`);
  const store = new RedisMessageStore(client, { ttlSeconds: 0 });
  const ledger = new RedisQueueLedgerStore(client);
  let input;
  const f = await appendRecoveryFixture(
    async (value) => {
      input = value;
      return acceptance === 'accepted'
        ? {
            accepted: true,
            handle: { provider: 'google', carrier: 'agy_stream_json', threadId: 'native', turnId: 'first' },
          }
        : { accepted: false, reason: 'exception', acceptance: 'unknown' };
    },
    { messageStore: store, ledgerStore: ledger, inputCompletionReceipt: true },
  );
  return { ...f, client, ledger, input: () => input };
}

for (const operation of ['hydrate', 'reconcile']) {
  test(`Redis ${operation} preserves a read native input when another target owns a claim`, async () => {
    const f = await fixture();
    await f.queue.reconcileQueuedMessageTargetsDurable('thread', 'owner', f.admission.entry.id, ['codex'], [], {});
    await f.append();
    await f.input().onInputRead();
    assert.equal(
      (await f.ledger.claim('thread', f.admission.entry.id, 'sibling', Date.now(), 'codex')).outcome,
      'claimed',
    );
    const queue = new InvocationQueue(new RedisQueueLedgerStore(f.client));
    if (operation === 'hydrate') await queue.hydrateFromLedger(f.messageStore);
    else await queue.reconcileClaimedLifecycleTargets('thread', [f.admission.entry.id], f.messageStore);
    const row = await f.ledger.get('thread', f.admission.entry.id);
    assert.deepEqual(row.targets, ['codex']);
    assert.equal(row.status, 'queued', 'startup releases the orphan sibling claim but retains its work');
    assert.equal(
      (await f.messageStore.getById(f.admission.message.id)).lifecycle.dispatchRefs[0].appendDelivery
        .requiresCompletion,
      true,
    );
    const restarted = recoveryProcessor({ queue, messageStore: f.messageStore });
    await restarted.reconcileAppendDeliveries('thread');
    await restarted.requestDrain('thread');
    await restarted.reconcileAppendDeliveries('thread');
    assert.equal(
      (await f.messageStore.getById(f.admission.message.id)).lifecycle.appendFailures[0].acceptance,
      'incomplete',
    );
    assert.equal(await f.client.ttl('msg:' + f.admission.message.id), -1);
  });
}

for (const operation of ['entry', 'message']) {
  test(`Redis canonical ${operation} withdrawal protects native input even with a stale cache`, async () => {
    const f = await fixture();
    const stale = new InvocationQueue(new RedisQueueLedgerStore(f.client));
    await stale.hydrateFromLedger(f.messageStore);
    await f.append();
    if (operation === 'entry')
      assert.equal(await stale.claimQueuedEntryForWithdrawal('thread', 'owner', f.admission.entry.id), null);
    else
      assert.equal(
        (await stale.claimMessageEntriesForWithdrawal('thread', 'owner', f.admission.message.id)).outcome,
        'not_found',
      );
    assert.equal(await f.ledger.get('thread', f.admission.entry.id), null);
    await f.input().onInputCompleted(false);
    await f.processor.requestDrain('thread');
    await f.processor.reconcileAppendDeliveries('thread');
    assert.equal((await f.messageStore.getById(f.response.id)).lifecycle.inputMessageIds.length, 1);
    assert.equal(
      (await f.messageStore.getById(f.admission.message.id)).lifecycle.appendFailures[0].acceptance,
      'incomplete',
    );
  });
}

test('Redis read racing incomplete native compensation preserves exact membership and uncertain custody', async () => {
  const f = await fixture();
  await f.append();
  const evaluate = f.client.eval.bind(f.client);
  let injected = false;
  f.client.eval = async (script, ...args) => {
    if (!injected && script.includes('APPEND_RECOVERY_WRONG_KEY_TYPE')) {
      injected = true;
      await f.input().onInputRead();
    }
    return evaluate(script, ...args);
  };
  await f.input().onInputCompleted(false);
  await f.processor.requestDrain('thread');
  await f.processor.reconcileAppendDeliveries('thread');
  assert.equal(injected, true);
  assert.equal((await f.messageStore.getById(f.response.id)).lifecycle.inputMessageIds.length, 1);
  assert.equal(
    (await f.messageStore.getById(f.admission.message.id)).lifecycle.dispatchRefs[0].inputRead.status,
    'read',
  );
  assert.equal(
    (await f.messageStore.getById(f.admission.message.id)).lifecycle.appendFailures[0].acceptance,
    'incomplete',
  );
});

test('Redis uncertain native write and late read preserve the completion fence across reopen', async () => {
  const f = await fixture('unknown');
  await f.append();
  await f.input().onInputRead();
  const reopened = new RedisMessageStore(f.client, { ttlSeconds: 0 });
  const queue = new InvocationQueue(new RedisQueueLedgerStore(f.client));
  await queue.hydrateFromLedger(reopened);
  assert.equal(
    (await reopened.getById(f.admission.message.id)).lifecycle.dispatchRefs[0].appendDelivery.requiresCompletion,
    true,
  );
  const restarted = recoveryProcessor({ queue, messageStore: reopened });
  await restarted.reconcileAppendDeliveries('thread');
  await restarted.requestDrain('thread');
  await restarted.reconcileAppendDeliveries('thread');
  assert.equal(
    (await f.messageStore.getById(f.admission.message.id)).lifecycle.appendFailures[0].acceptance,
    'incomplete',
  );
});
