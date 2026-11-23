import assert from 'node:assert/strict';
import { test } from 'node:test';
import { admissionFixture, enqueueUser, gateAttempt, socketFixture } from './helpers/stop-admission-fixture.js';
import { waitFor } from './helpers/stop-private-fixture.js';

for (const stage of ['claim-before', 'claim-after', 'receiver', 'source', 'durable', 'record']) {
  for (const reverse of [false, true]) {
    test(`#2008 Stop remains effective after both exact terminals, ${stage}, reverse=${reverse}`, async (t) => {
      const h = await admissionFixture(t);
      const stop = await socketFixture(t, h);
      const source = await enqueueUser(h);
      h.processor.suppressAutoResume('thread', 'sonnet', ['old-stop']);
      const gate = gateAttempt(h, source, stage);
      t.after(() => gate.release());
      const drain = h.processor.onInvocationComplete('thread', 'sonnet', 'canceled_by_user', 'new-completion');
      await gate.waiting;
      const controller = await stop('sonnet', 'default-user');
      h.tracker.complete('thread', 'sonnet', controller);
      const terminals = reverse ? ['new-stop', 'old-stop'] : ['old-stop', 'new-stop'];
      for (const id of terminals) await h.processor.onInvocationComplete('thread', 'sonnet', 'canceled_by_user', id);
      assert.equal(h.processor.isAutoResumeSuppressed('thread', 'sonnet'), false);
      gate.release();
      await drain;
      await waitFor(() => !h.processor.hasProcessingSlotReservation('thread', 'sonnet'));
      assert.deepEqual(h.starts, [], 'consumed fence does not authorize the revoked admission');
      assert.equal((await h.queue.getDurableEntry('thread', source.entry.id)).status, 'queued');
      // A later explicit admission is new authority, not a continuation of the revoked attempt.
      assert.equal((await h.processor.processNext('thread', 'default-user')).started, true);
      await waitFor(() => h.starts.length === 1);
      assert.deepEqual(h.starts, ['pending source']);
    });
  }
}

test('#2008 a targetless admission remembers Stop during asynchronous target resolution', async (t) => {
  const h = await admissionFixture(t);
  const stop = await socketFixture(t, h);
  const source = await enqueueUser(h, 'targetless source', []);
  let enter;
  let release;
  const entered = new Promise((resolve) => {
    enter = resolve;
  });
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  h.processor.deps.router.resolveConversationTargetsAtAdmission = async () => {
    enter();
    await gate;
    return ['sonnet'];
  };
  t.after(() => release());
  const drain = h.processor.requestDrain('thread');
  await entered;
  const controller = await stop('sonnet', 'default-user');
  h.tracker.complete('thread', 'sonnet', controller);
  await h.processor.onInvocationComplete('thread', 'sonnet', 'canceled_by_user', 'new-stop');
  release();
  await drain;
  assert.deepEqual(h.starts, []);
  assert.equal((await h.queue.getDurableEntry('thread', source.entry.id)).status, 'queued');
});
