import assert from 'node:assert/strict';
import { test } from 'node:test';
import { InvocationQueue } from '../dist/domains/cats/services/agents/invocation/InvocationQueue.js';
import { InMemoryQueueLedgerStore } from '../dist/domains/cats/services/agents/invocation/queue-ledger/InMemoryQueueLedgerStore.js';
import { appendRecoveryFixture } from './helpers/append-recovery-fixture.js';

test('History owns an append before the provider returns; Queue contains no dispatched target', async () => {
  let release;
  let entered;
  const handoff = new Promise((resolve) => {
    entered = resolve;
  });
  const f = await appendRecoveryFixture(() => {
    entered();
    return new Promise((resolve) => {
      release = resolve;
    });
  });
  const result = f.append();
  await handoff;
  try {
    const source = await f.messageStore.getById(f.admission.message.id);
    assert.equal(source.lifecycle.dispatchRefs[0].statusMessageId, f.response.id);
    assert.equal(source.lifecycle.dispatchRefs[0].appendAcceptance, 'pending');
    assert.equal(
      await f.queue.getDurableEntry('thread', f.admission.entry.id),
      null,
      'provider acknowledgement is a History receipt, not Queue membership',
    );
  } finally {
    release({ accepted: true });
    await result;
  }
});

test('unknown append remains recoverable in History after Queue hydration without a second dispatch', async () => {
  let sends = 0;
  const ledgerStore = new InMemoryQueueLedgerStore();
  const f = await appendRecoveryFixture(
    async () => {
      sends++;
      return { accepted: false, reason: 'exception', acceptance: 'unknown' };
    },
    { ledgerStore },
  );
  await f.append();
  await f.processor.reconcileAppendDeliveries('thread');
  const restartedQueue = new InvocationQueue(ledgerStore);
  await restartedQueue.hydrateFromLedger(f.messageStore);
  assert.deepEqual(
    restartedQueue.list('thread', 'owner'),
    [],
    'a restart must not revive an already handed-over input as pending work',
  );
  const source = await f.messageStore.getById(f.admission.message.id);
  assert.equal(source.lifecycle.dispatchRefs[0].statusMessageId, f.response.id);
  assert.equal(source.lifecycle.appendFailures[0].acceptance, 'unknown');
  assert.equal(sends, 1);
});

test('a definite live refusal atomically records its old outcome and admits only next-round pending work', async () => {
  const f = await appendRecoveryFixture(async () => ({
    accepted: false,
    reason: 'active_run_closed',
    acceptance: 'not_accepted',
  }));
  const result = await f.append();
  assert.equal(result.outcome, 'rejected');
  const source = await f.messageStore.getById(f.admission.message.id);
  const row = await f.queue.getDurableEntry('thread', f.admission.entry.id);
  assert.equal(source.lifecycle.appendFailures[0].responseMessageId, f.response.id);
  assert.equal(source.lifecycle.appendFailures[0].acceptance, 'not_accepted');
  assert.deepEqual(source.lifecycle.dispatchRefs, []);
  assert.deepEqual(row.targets, ['opus']);
  assert.deepEqual(row.execution, f.admission.entry.execution);
  assert.equal(row.delivery.authorIntentByTarget.opus.requested, 'next_work');
  assert.equal(row.delivery.appendPendingByTarget, undefined);
  assert.equal(row.delivery.appendRecoveryByTarget, undefined);
});

for (const stop of ['abort', 'suppression', 'both']) {
  test(`${stop} during the handoff prevents a later definite refusal from resurrecting pending work`, async () => {
    let release;
    let entered;
    const handoff = new Promise((resolve) => {
      entered = resolve;
    });
    const f = await appendRecoveryFixture(() => {
      entered();
      return new Promise((resolve) => {
        release = resolve;
      });
    });
    const appending = f.append();
    await handoff;
    if (stop !== 'abort') f.processor.suppressAutoResume('thread', 'opus');
    if (stop !== 'suppression') f.invocationTracker.cancelAll('thread', 'owner', 'user_cancel');
    release({ accepted: false, reason: 'active_run_closed', acceptance: 'not_accepted' });
    await appending;
    assert.equal(await f.queue.getDurableEntry('thread', f.admission.entry.id), null);
    const source = await f.messageStore.getById(f.admission.message.id);
    assert.equal(source.lifecycle.dispatchRefs[0].statusMessageId, f.response.id);
    assert.equal(source.lifecycle.appendFailures[0].acceptance, 'not_accepted');
  });
}

test('an incomplete native turn stays visible in History without an automatic duplicate', async () => {
  let input;
  const f = await appendRecoveryFixture(
    async (value) => {
      input = value;
      return { accepted: true };
    },
    { inputCompletionReceipt: true },
  );
  await f.append();
  await input.onInputRead();
  await input.onInputCompleted(false);
  const source = await f.messageStore.getById(f.admission.message.id);
  assert.equal(source.lifecycle.dispatchRefs[0].inputRead.status, 'read');
  assert.equal(source.lifecycle.appendFailures[0].acceptance, 'incomplete');
  assert.equal(await f.queue.getDurableEntry('thread', f.admission.entry.id), null);
});

test('native stdin ACK awaiting its own completion belongs to History, including a late read', async () => {
  let input;
  const f = await appendRecoveryFixture(
    async (value) => {
      input = value;
      return { accepted: true };
    },
    { inputCompletionReceipt: true },
  );
  await f.append();
  await input.onInputRead();
  const source = await f.messageStore.getById(f.admission.message.id);
  assert.equal(source.lifecycle.dispatchRefs[0].appendAcceptance, 'written');
  assert.equal(source.lifecycle.dispatchRefs[0].inputRead.status, 'read');
  assert.equal(
    await f.queue.getDurableEntry('thread', f.admission.entry.id),
    null,
    'awaiting a result cannot leave a dispatched target in the pending Queue',
  );
  await input.onInputCompleted(true);
  assert.equal((await f.messageStore.getById(source.id)).lifecycle.dispatchRefs[0].appendAcceptance, 'accepted');
});

test('a late unknown probe cannot overwrite a definite refusal already stored in History', async () => {
  const f = await appendRecoveryFixture(async () => ({
    accepted: false,
    reason: 'active_run_closed',
    acceptance: 'not_accepted',
  }));
  f.processor.suppressAutoResume('thread', 'opus');
  await f.append();
  const source = await f.messageStore.getById(f.admission.message.id);
  const failure = source.lifecycle.appendFailures[0];
  const result = await f.queue.recoverLifecycleAppend(f.messageStore, {
    sourceMessageId: source.id,
    threadId: 'thread',
    failure: { ...failure, acceptance: 'unknown' },
    checked: { acceptance: 'unknown', at: failure.at + 1 },
  });
  assert.equal(result.kind, 'applied');
  assert.equal((await f.messageStore.getById(source.id)).lifecycle.appendFailures[0].acceptance, 'not_accepted');
  assert.deepEqual(f.queue.list('thread', 'owner'), []);
});

test('exact native reading defeats a racing refusal probe without losing the own-completion obligation', async () => {
  let input;
  const f = await appendRecoveryFixture(
    async (value) => {
      input = value;
      return { accepted: false, reason: 'exception', acceptance: 'unknown' };
    },
    { inputCompletionReceipt: true },
  );
  await f.append();
  await input.onInputRead();
  const source = await f.messageStore.getById(f.admission.message.id);
  const failure = source.lifecycle.appendFailures[0];
  const result = await f.queue.recoverLifecycleAppend(f.messageStore, {
    entry: f.admission.entry,
    failure,
    canResume: () => true,
    checked: { acceptance: 'not_accepted', at: failure.at + 1 },
  });
  assert.equal(result.kind, 'applied');
  const updated = await f.messageStore.getById(source.id);
  assert.equal(updated.lifecycle.appendFailures[0].acceptance, 'unknown');
  assert.equal(updated.lifecycle.dispatchRefs[0].inputRead.status, 'read');
  assert.equal(updated.lifecycle.dispatchRefs[0].appendDelivery.requiresCompletion, true);
  assert.deepEqual(f.queue.list('thread', 'owner'), []);
});
