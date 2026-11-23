import assert from 'node:assert/strict';
import { test } from 'node:test';
import { admissionFixture, enqueueUser, gateAttempt, socketFixture } from './helpers/stop-admission-fixture.js';
import { waitFor } from './helpers/stop-private-fixture.js';

for (const stage of ['resolution', 'claim-before', 'claim-after', 'receiver', 'source', 'durable', 'record']) {
  for (const stoppedTarget of ['opus', 'codex']) {
    test(`#2008 ${stage} Stop on ${stoppedTarget} preserves the sibling and later same-target order`, async (t) => {
      const h = await admissionFixture(t);
      const stop = await socketFixture(t, h);
      const unstopped = stoppedTarget === 'opus' ? 'codex' : 'opus';
      const starts = [];
      const route = h.processor.deps.router.routeExecution;
      h.processor.deps.router.routeExecution = async function* (...args) {
        starts.push({ content: args[1], targets: [...args[4]], parent: args[6].parentInvocationId });
        yield* route(...args);
      };
      const a = await enqueueUser(h, 'shared A', ['opus', 'codex']);
      await enqueueUser(h, 'later B', [unstopped]);
      const gate = gateAttempt(h, a, stage);
      t.after(() => gate.release());
      const drain = h.processor.requestDrain('thread');
      await gate.waiting;
      const oldRecord = await h.records.getByIdempotencyKey(
        'thread',
        'default-user',
        `queue-${a.entry.id}:opus:${JSON.stringify(['opus', 'codex'])}`,
      );
      const controller = await stop(stoppedTarget, 'default-user');
      h.tracker.complete('thread', stoppedTarget, controller);
      await h.processor.onInvocationComplete('thread', stoppedTarget, 'canceled_by_user', 'new-stop');
      assert.equal(h.processor.isAutoResumeSuppressed('thread', stoppedTarget), false);
      gate.release();
      await drain;
      await waitFor(() => starts.some((entry) => entry.content === 'later B'));
      assert.equal(starts[0].content, 'shared A');
      assert.deepEqual(starts[0].targets, [unstopped]);
      if (oldRecord)
        assert.equal(
          starts.some((entry) => entry.parent === oldRecord.id),
          false,
          'old record never executes',
        );
      assert.deepEqual(
        starts.filter((entry) => entry.targets.includes(unstopped)).map((entry) => entry.content),
        ['shared A', 'later B'],
      );
      // A later real durable handoff is new scheduling; the old full-target
      // attempt above must not dispatch the stopped recipient itself.
    });
  }
}

for (const freshWake of [false, true]) {
  test(`#2008 a fresh wake coalesced into a revoked continuation is kept: fresh=${freshWake}`, async (t) => {
    const h = await admissionFixture(t);
    const stop = await socketFixture(t, h);
    const a = await enqueueUser(h, 'restored A');
    const recordGate = gateAttempt(h, a, 'record');
    t.after(() => recordGate.release());
    await h.processor.requestDrain('thread');
    await recordGate.waiting;
    const controller = await stop('sonnet', 'default-user');
    h.tracker.complete('thread', 'sonnet', controller);
    await h.processor.onInvocationComplete('thread', 'sonnet', 'canceled_by_user', 'new-stop');
    const busy = h.tracker.start('thread', 'gemini', 'other-owner', ['gemini'], 'busy');
    t.after(() => h.tracker.complete('thread', 'gemini', busy));
    await enqueueUser(h, 'busy B', ['gemini']);
    let enter;
    let release;
    const entered = new Promise((resolve) => {
      enter = resolve;
    });
    const gate = new Promise((resolve) => {
      release = resolve;
    });
    let blocked = false;
    const resolve = h.processor.deps.router.resolveExplicitTargets;
    h.processor.deps.router.resolveExplicitTargets = async (ids, ...args) => {
      if (ids.includes('gemini') && !blocked) {
        blocked = true;
        enter();
        await gate;
      }
      return resolve(ids, ...args);
    };
    t.after(() => release());
    recordGate.release();
    await entered;
    const wake = freshWake ? h.processor.requestDrain('thread') : undefined;
    release();
    await wake;
    await waitFor(() => !h.processor.hasProcessingSlotReservation('thread', 'sonnet'));
    if (freshWake) await waitFor(() => h.starts.includes('restored A'));
    assert.deepEqual(h.starts, freshWake ? ['restored A'] : []);
  });
}

for (const laterStop of ['none', 'same-member', 'other-member']) {
  test(`#2008 handoff during exact restore is kept and only a newer relevant Stop revokes it: ${laterStop}`, async (t) => {
    const h = await admissionFixture(t);
    const stop = await socketFixture(t, h);
    const a = await enqueueUser(h, 'restored A');
    const recordGate = gateAttempt(h, a, 'record');
    t.after(() => recordGate.release());
    await h.processor.requestDrain('thread');
    await recordGate.waiting;
    const controller = await stop('sonnet', 'default-user');
    h.tracker.complete('thread', 'sonnet', controller);
    await h.processor.onInvocationComplete('thread', 'sonnet', 'canceled_by_user', 'new-stop');
    let enter;
    let release;
    const entered = new Promise((resolve) => {
      enter = resolve;
    });
    const gate = new Promise((resolve) => {
      release = resolve;
    });
    const restore = h.ledger.restore.bind(h.ledger);
    h.ledger.restore = async (...args) => {
      if (args[1] === a.entry.id) {
        enter();
        await gate;
      }
      return restore(...args);
    };
    t.after(() => release());
    let bCompleted = false;
    const complete = h.processor.onInvocationComplete.bind(h.processor);
    h.processor.onInvocationComplete = async (...args) => {
      await complete(...args);
      if (args[1] === 'gemini' && args[2] === 'succeeded') bCompleted = true;
    };
    recordGate.release();
    await entered;
    await enqueueUser(h, 'independent B', ['gemini']);
    await h.processor.requestDrain('thread');
    await waitFor(() => bCompleted);
    assert.deepEqual(h.starts, ['independent B']);
    if (laterStop !== 'none') {
      const catId = laterStop === 'same-member' ? 'sonnet' : 'codex';
      const newer = await stop(catId, 'default-user');
      const executionId = h.tracker.getExecutionId('thread', catId);
      h.tracker.complete('thread', catId, newer);
      await h.processor.onInvocationComplete('thread', catId, 'canceled_by_user', executionId);
    }
    release();
    if (laterStop === 'same-member') {
      await waitFor(
        () =>
          !h.processor.hasProcessingSlotReservation('thread', 'sonnet') &&
          !h.processor.threadDrains.get('thread')?.owner,
      );
      assert.deepEqual(h.starts, ['independent B']);
    } else {
      await waitFor(() => h.starts.includes('restored A'));
      assert.deepEqual(h.starts, ['independent B', 'restored A']);
    }
  });
}
