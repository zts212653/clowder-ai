import assert from 'node:assert/strict';
import { mock, test } from 'node:test';
import { enrichQueueEntries } from '../dist/utils/queue-enrichment.js';
import { appendRecoveryFixture } from './helpers/append-recovery-fixture.js';

for (const proof of ['accepted', 'not_accepted', 'unknown']) {
  test(`system reconciles exact original handoff (${proof}) without another dispatch`, async () => {
    let finishProbe;
    let beginProbe;
    const probing = new Promise((resolve) => {
      beginProbe = resolve;
    });
    const dispatch = mock.fn(async () => ({ accepted: false, reason: 'exception', acceptance: 'unknown' }));
    const inspectInput = mock.fn(async () => {
      beginProbe();
      return new Promise((resolve) => {
        finishProbe = resolve;
      });
    });
    const f = await appendRecoveryFixture(dispatch, { inspectInput });
    await f.append();
    const initial = f.messageStore.getById(f.admission.message.id);
    assert.equal(initial.lifecycle.appendFailures[0].checkedAt, undefined);
    const rows = await enrichQueueEntries(f.queue.list('thread', 'owner'), f.messageStore);
    assert.deepEqual(rows, [], 'checking belongs to History, not a synthetic Queue row');
    assert.deepEqual(await f.processor.retryRoutingTarget('thread', 'owner', f.admission.entry.id, 'opus'), {
      started: false,
    });
    await probing;
    assert.equal(inspectInput.mock.calls[0].arguments[0], dispatch.mock.calls[0].arguments[0].deliveryId);
    assert.ok(dispatch.mock.calls[0].arguments[0].deliveryId);
    finishProbe(proof);
    await f.processor.requestDrain('thread');
    await f.processor.reconcileAppendDeliveries('thread');
    assert.equal(dispatch.mock.calls.length, 1);
    const source = f.messageStore.getById(f.admission.message.id);
    const entry = await f.queue.getDurableEntry('thread', f.admission.entry.id);
    if (proof === 'accepted') {
      assert.equal(entry, null);
      assert.equal(source.lifecycle.dispatchRefs[0].appendAcceptance, 'accepted');
      assert.equal(source.lifecycle.dispatchRefs[0].inputRead.status, 'pending');
    } else {
      assert.ok(source.lifecycle.appendFailures[0].checkedAt);
      assert.equal(source.lifecycle.appendFailures[0].acceptance, proof);
      assert.equal(entry, null, 'a read-only probe cannot create pending work');
      assert.equal(source.lifecycle.dispatchRefs[0].statusMessageId, f.response.id);
    }
  });
}

test('late native receipt wins a simultaneous negative reconciliation', async () => {
  let inputRead;
  const f = await appendRecoveryFixture(
    async (input) => {
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
  await f.processor.requestDrain('thread');
  await f.processor.reconcileAppendDeliveries('thread');
  assert.equal(await f.queue.getDurableEntry('thread', f.admission.entry.id), null);
  assert.equal(f.messageStore.getById(f.admission.message.id).lifecycle.dispatchRefs[0].inputRead.status, 'read');
});

test('a failed recovery write leaves the original handoff recoverable in durable History', async () => {
  const f = await appendRecoveryFixture(async () => ({
    accepted: false,
    reason: 'active_run_closed',
    acceptance: 'not_accepted',
  }));
  f.messageStore.commitLifecycleAppendRecovery = async () => {
    throw new Error('storage temporarily unavailable');
  };
  const result = await f.append();
  assert.equal(result.outcome, 'rejected');
  const row = await f.queue.getDurableEntry('thread', f.admission.entry.id);
  assert.equal(row, null);
  assert.equal(f.messageStore.listUnresolvedAppendMessages('thread')[0].id, f.admission.message.id);
  assert.equal(f.messageStore.getById(f.admission.message.id).lifecycle.dispatchRefs[0].appendAcceptance, 'pending');
});

test('a pending read-only reconciliation does not hold the thread admission drain', async () => {
  let finish;
  const f = await appendRecoveryFixture(async () => ({ accepted: false, reason: 'exception', acceptance: 'unknown' }), {
    inspectInput: () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  });
  await f.append();
  try {
    const drained = await Promise.race([
      f.processor.requestDrain('thread').then(() => true),
      new Promise((resolve) => setTimeout(() => resolve(false), 50)),
    ]);
    assert.equal(drained, true, 'the original body stays held while unrelated admission can continue');
  } finally {
    finish?.('unknown');
  }
});

test('Stop while an outcome write waits cannot be overtaken by the live admission snapshot', async () => {
  let release;
  let entered;
  const waiting = new Promise((resolve) => {
    entered = resolve;
  });
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const f = await appendRecoveryFixture(async () => ({
    accepted: false,
    reason: 'active_run_closed',
    acceptance: 'not_accepted',
  }));
  const commit = f.messageStore.commitLifecycleAppendRecovery.bind(f.messageStore);
  f.messageStore.commitLifecycleAppendRecovery = async (...args) => {
    entered();
    await gate;
    return commit(...args);
  };
  const appending = f.append();
  await waiting;
  f.invocationTracker.cancelAll('thread', 'owner', 'user_cancel');
  f.processor.suppressAutoResume('thread', 'opus');
  release();
  await appending;
  assert.equal(await f.queue.getDurableEntry('thread', f.admission.entry.id), null);
  assert.equal(
    (await f.messageStore.getById(f.admission.message.id)).lifecycle.appendFailures[0].acceptance,
    'not_accepted',
  );
});
