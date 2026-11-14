import assert from 'node:assert/strict';
import { test } from 'node:test';
import { appendRecoveryFixture, recoveryProcessor } from './helpers/append-recovery-fixture.js';

for (const completed of [true, false]) {
  test(`completion-aware Append keeps its own result in History (${completed})`, async () => {
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
    assert.equal(f.queue.list('thread', 'owner').length, 0, 'handoff transfers ownership to History');
    await input.onInputRead();
    const read = (await f.messageStore.getById(f.admission.message.id)).lifecycle.dispatchRefs[0];
    assert.equal(read.inputRead.status, 'read');
    assert.equal(f.queue.list('thread', 'owner').length, 0, 'reading does not change Queue ownership');
    assert.equal(read.appendAcceptance, 'written', 'reading is not successful completion');
    await input.onInputCompleted(completed);
    await input.onInputCompleted(completed);
    assert.equal(f.queue.list('thread', 'owner').length, 0);
    const source = await f.messageStore.getById(f.admission.message.id);
    if (completed) assert.equal(source.lifecycle.dispatchRefs[0].appendAcceptance, 'accepted');
    else {
      assert.equal(source.lifecycle.dispatchRefs?.[0].inputRead.status, 'read');
      assert.equal(source.lifecycle.appendFailures[0].acceptance, 'incomplete');
      assert.equal((await f.messageStore.getById(f.response.id)).lifecycle.inputMessageIds.length, 1);
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

  // History survives; the restarted tracker has no live dispatcher.
  const restarted = recoveryProcessor({ queue: f.queue, messageStore: f.messageStore });
  await restarted.reconcileAppendDeliveries('thread');
  assert.deepEqual(f.queue.list('thread', 'owner'), []);
  const history = await f.messageStore.getById(f.admission.message.id);
  assert.equal(history.lifecycle.appendFailures[0].acceptance, 'incomplete');
  assert.equal(history.lifecycle.dispatchRefs[0].inputRead.status, 'read');
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
  const history = await f.messageStore.getById(f.admission.message.id);
  assert.equal(history.lifecycle.dispatchRefs[0].appendDelivery.requiresCompletion, true);
  assert.equal(history.lifecycle.appendFailures, undefined);
  assert.deepEqual(f.queue.list('thread', 'owner'), []);
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
  const history = await f.messageStore.getById(f.admission.message.id);
  assert.equal(history.lifecycle.dispatchRefs[0].appendDelivery.requiresCompletion, true);
  assert.notEqual(history.lifecycle.dispatchRefs[0].appendAcceptance, 'accepted');
  assert.deepEqual(f.queue.list('thread', 'owner'), []);
  await input.onInputCompleted(false);
  assert.equal(
    (await f.messageStore.getById(f.admission.message.id)).lifecycle.appendFailures[0].acceptance,
    'incomplete',
  );
  assert.equal((await f.messageStore.getById(f.response.id)).lifecycle.inputMessageIds.length, 1);
});

for (const pauseWriteReceipt of [false, true]) {
  test(`a late stdin ACK cannot erase the failure of its own internal turn (${pauseWriteReceipt})`, async () => {
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
      const source = await f.messageStore.getById(f.admission.message.id);
      assert.equal(source.lifecycle.dispatchRefs[0].statusMessageId, f.response.id);
      assert.notEqual(source.lifecycle.dispatchRefs[0].appendAcceptance, 'accepted');
      assert.equal(source.lifecycle.appendFailures[0].acceptance, 'incomplete');
      assert.equal((await f.messageStore.getById(f.response.id)).lifecycle.inputMessageIds.length, 1);
      assert.deepEqual(f.queue.list('thread', 'owner'), []);
    } finally {
      releaseWrite();
    }
  });
}
