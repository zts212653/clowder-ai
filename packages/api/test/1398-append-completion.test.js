import assert from 'node:assert/strict';
import { test } from 'node:test';
import { appendRecoveryFixture, recoveryProcessor } from './helpers/append-recovery-fixture.js';

for (const completed of [true, false]) {
  test(`completion-aware Append remains in durable Queue until its own result (${completed})`, async () => {
    let input;
    const f = await appendRecoveryFixture(
      async (value) => {
        input = value;
        return { accepted: true, handle: { provider: 'other', carrier: 'other', threadId: 'native', turnId: 'first' } };
      },
      { inputCompletionReceipt: true },
    );
    assert.equal((await f.append()).outcome, 'appended');
    assert.equal(
      (await f.messageStore.getById(f.admission.message.id)).lifecycle.dispatchRefs[0].appendAcceptance,
      'written',
      'confirmed stdin delivery is distinct from an uncertain write and successful internal-turn completion',
    );
    assert.equal(f.queue.list('thread', 'owner').length, 1, 'handoff must not drop the original Queue owner');
    await input.onInputRead();
    const read = (await f.messageStore.getById(f.admission.message.id)).lifecycle.dispatchRefs[0];
    assert.equal(read.inputRead.status, 'read');
    assert.equal(f.queue.list('thread', 'owner').length, 1, 'read is not successful completion');
    await input.onInputCompleted(completed);
    await input.onInputCompleted(completed);
    assert.equal(f.queue.list('thread', 'owner').length, completed ? 0 : 1);
    const source = await f.messageStore.getById(f.admission.message.id);
    if (completed) assert.equal(source.lifecycle.dispatchRefs[0].appendAcceptance, 'accepted');
    else {
      assert.equal(source.lifecycle.dispatchRefs?.length ?? 0, 0);
      const entry = f.queue.list('thread', 'owner')[0];
      assert.equal(entry.delivery.routingHeldTargetIds?.length ?? 0, 0);
      assert.equal(entry.delivery.appendRecoveryByTarget.opus.acceptance, 'incomplete');
      assert.equal((await f.messageStore.getById(f.response.id)).lifecycle.inputMessageIds.length, 0);
    }
  });
}

test('restart recovers a completion-pending Append after its original run has ended', async () => {
  let input;
  const f = await appendRecoveryFixture(
    async (value) => {
      input = value;
      return { accepted: true, handle: { provider: 'other', carrier: 'other', threadId: 'native', turnId: 'first' } };
    },
    { inputCompletionReceipt: true },
  );
  await f.append();
  await input.onInputRead();

  // The durable Queue survives; there is no dispatcher in the restarted tracker.
  const restarted = recoveryProcessor({ queue: f.queue, messageStore: f.messageStore });
  await restarted.reconcileAppendDeliveries('thread');
  const row = f.queue.list('thread', 'owner')[0];
  assert.ok(row, 'an unfinished internal turn must remain recoverable');
  assert.equal(row.delivery.appendRecoveryByTarget.opus.acceptance, 'incomplete');
  assert.equal(row.delivery.routingHeldTargetIds?.length ?? 0, 0);
});

test('dispatcher release during final-result persistence is not an ended invocation', async () => {
  const f = await appendRecoveryFixture(
    async () => ({
      accepted: true,
      handle: { provider: 'other', carrier: 'other', threadId: 'native', turnId: 'first' },
    }),
    { inputCompletionReceipt: true },
  );
  await f.append();
  // Register returns a release hook; emulate just the live registry being closed.
  const original = f.invocationTracker.getAgentClientActiveRunDispatcher;
  f.invocationTracker.getAgentClientActiveRunDispatcher = () => undefined;
  await f.processor.reconcileAppendDeliveries('thread');
  const row = f.queue.list('thread', 'owner')[0];
  assert.equal(row.delivery.appendPendingByTarget.opus.requiresCompletion, true);
  assert.equal(row.delivery.appendRecoveryByTarget, undefined);
  f.invocationTracker.getAgentClientActiveRunDispatcher = original;
});

test('an unknown native write retains completion custody even after a late read', async () => {
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
  await f.processor.reconcileAppendDeliveries('thread');
  const row = f.queue.list('thread', 'owner')[0];
  assert.ok(row, 'read proof cannot retire an unfinished internal turn after an uncertain write');
  assert.equal(row.delivery.appendPendingByTarget.opus.requiresCompletion, true);
  await input.onInputCompleted(false);
  assert.equal(f.queue.list('thread', 'owner')[0].delivery.appendRecoveryByTarget.opus.acceptance, 'incomplete');
  assert.equal((await f.messageStore.getById(f.response.id)).lifecycle.inputMessageIds.length, 0);
});

for (const pauseWriteReceipt of [false, true]) {
  test(`a late stdin ACK cannot recreate a failed internal turn's dispatch binding (${pauseWriteReceipt})`, async () => {
    let input;
    let releaseWrite;
    let reachedWrite;
    const gate = new Promise((resolve) => {
      releaseWrite = resolve;
    });
    const reached = new Promise((resolve) => {
      reachedWrite = resolve;
    });
    const f = await appendRecoveryFixture(
      async (value) => {
        input = value;
        if (!pauseWriteReceipt) await value.onInputCompleted(false);
        return { accepted: true, handle: { provider: 'other', carrier: 'other', threadId: 'native', turnId: 'first' } };
      },
      { inputCompletionReceipt: true },
    );
    if (pauseWriteReceipt) {
      const advance = f.messageStore.advanceLifecycleInputDispatch.bind(f.messageStore);
      f.messageStore.advanceLifecycleInputDispatch = async (id, patch) => {
        if (patch.appendAcceptance === 'written') {
          reachedWrite();
          await gate;
        }
        return advance(id, patch);
      };
    }
    try {
      const append = f.append();
      if (pauseWriteReceipt) {
        await reached;
        await input.onInputCompleted(false);
        releaseWrite();
      }
      assert.equal(
        (await append).outcome,
        'appended',
        'a delayed write ACK must tolerate its already-compensated completion',
      );
      assert.equal((await f.messageStore.getById(f.admission.message.id)).lifecycle.dispatchRefs.length, 0);
      assert.equal((await f.messageStore.getById(f.response.id)).lifecycle.inputMessageIds.length, 0);
      assert.equal(f.queue.list('thread', 'owner')[0].delivery.appendRecoveryByTarget.opus.acceptance, 'incomplete');
    } finally {
      releaseWrite();
    }
  });
}
