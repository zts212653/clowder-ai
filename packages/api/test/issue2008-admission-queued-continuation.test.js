import assert from 'node:assert/strict';
import { test } from 'node:test';
import { admissionFixture, enqueueUser, gateAttempt, socketFixture } from './helpers/stop-admission-fixture.js';
import { waitFor } from './helpers/stop-private-fixture.js';

for (const scenario of ['no-new-stop', 'same-member', 'other-member', 'fresh-after-stop']) {
  test(`#2008 queued continuation observes later Stop and genuine scheduling: ${scenario}`, async (t) => {
    const h = await admissionFixture(t);
    const stop = await socketFixture(t, h);
    const a = await enqueueUser(h, 'restored A', ['sonnet']);
    const recordGate = gateAttempt(h, a, 'record');
    t.after(() => recordGate.release());
    await h.processor.requestDrain('thread');
    await recordGate.waiting;
    let controller = await stop('sonnet', 'default-user');
    h.tracker.complete('thread', 'sonnet', controller);
    await h.processor.onInvocationComplete('thread', 'sonnet', 'canceled_by_user', 'new-stop');
    assert.equal(h.processor.isAutoResumeSuppressed('thread', 'sonnet'), false);
    let enterRestore, releaseRestore;
    const restoreEntered = new Promise((resolve) => {
      enterRestore = resolve;
    });
    const restoreGate = new Promise((resolve) => {
      releaseRestore = resolve;
    });
    const restore = h.ledger.restore.bind(h.ledger);
    h.ledger.restore = async (...args) => {
      if (args[1] === a.entry.id) {
        enterRestore();
        await restoreGate;
      }
      return restore(...args);
    };
    t.after(() => releaseRestore());
    recordGate.release();
    await restoreEntered;
    const busy = h.tracker.start('thread', 'gemini', 'other-owner', ['gemini'], 'busy');
    t.after(() => h.tracker.complete('thread', 'gemini', busy));
    await enqueueUser(h, 'busy B', ['gemini']);
    let enterResolve, releaseResolve;
    const resolveEntered = new Promise((resolve) => {
      enterResolve = resolve;
    });
    const resolveGate = new Promise((resolve) => {
      releaseResolve = resolve;
    });
    const resolve = h.processor.deps.router.resolveExplicitTargets;
    let paused = false;
    h.processor.deps.router.resolveExplicitTargets = async (ids, ...args) => {
      if (ids.includes('gemini') && !paused) {
        paused = true;
        enterResolve();
        await resolveGate;
      }
      return resolve(ids, ...args);
    };
    t.after(() => releaseResolve());
    const concurrentDrain = h.processor.requestDrain('thread');
    await resolveEntered;
    releaseRestore();
    await waitFor(() => h.processor.threadDrains.get('thread')?.continuationAdmission);
    const pending = h.processor.threadDrains.get('thread').continuationAdmission;
    assert.equal(
      pending.stoppedTargets.has('sonnet'),
      false,
      'the earlier fresh wake cleared the old stop for this successor',
    );
    assert.equal((await h.queue.getDurableEntry('thread', a.entry.id)).status, 'queued');
    if (scenario !== 'no-new-stop') {
      const catId = scenario === 'other-member' ? 'codex' : 'sonnet';
      controller = await stop(catId, 'default-user');
      h.tracker.complete('thread', catId, controller);
      await h.processor.onInvocationComplete('thread', catId, 'canceled_by_user', 'new-stop-2');
      assert.equal(
        h.processor.isAutoResumeSuppressed('thread', catId),
        false,
        'matching terminal consumed the new fence',
      );
    }
    // A real request after the new Stop may schedule a new attempt. Merely
    // resuming an already-queued continuation has no such authority.
    const fresh = scenario === 'fresh-after-stop' ? h.processor.requestDrain('thread') : undefined;
    releaseResolve();
    await concurrentDrain;
    await fresh;
    await waitFor(
      () => !h.processor.hasProcessingSlotReservation('thread', 'sonnet') && !h.tracker.has('thread', 'sonnet'),
    );
    const blocked = scenario === 'same-member';
    assert.deepEqual(h.starts, blocked ? [] : ['restored A']);
    if (blocked) {
      assert.equal((await h.queue.getDurableEntry('thread', a.entry.id))?.status, 'queued');
      assert.equal(h.processor.hasProcessingSlotReservation('thread', 'sonnet'), false);
      await h.processor.processNext('thread', 'default-user');
      await waitFor(() => h.starts.includes('restored A'));
      assert.deepEqual(h.starts, ['restored A'], 'explicit new admission can resume the original pending source');
    }
  });
}
