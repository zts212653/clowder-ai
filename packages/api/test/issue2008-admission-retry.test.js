import assert from 'node:assert/strict';
import { test } from 'node:test';
import { stopFixture, waitFor } from './helpers/stop-private-fixture.js';

[
  { legacy: true, failures: 1 },
  { legacy: true, failures: 2 },
  { legacy: false, failures: 1 },
  { legacy: false, failures: 2 },
].forEach(({ legacy, failures }) => {
  test(`#2008 last handoff wake: legacy=${legacy}, failed source reads=${failures}`, async (t) => {
    const h = await stopFixture(t, { idle: true, retryDeferral: { baseDelayMs: 20 } });
    let finishTeardown;
    const teardown = new Promise((resolve) => {
      finishTeardown = resolve;
    });
    t.after(() => finishTeardown());
    const route = h.processor.deps.router.routeExecution;
    h.processor.deps.router.routeExecution = async function* (...args) {
      yield* route(...args);
      if (args[1] === 'active') await teardown;
    };
    await h.send('active');
    await h.processor.requestDrain('thread');
    await waitFor(() => h.starts.length === 1);
    const oldExecutionId = h.tracker.getExecutionId('thread', 'opus');
    const next = await h.send('new input');
    let oldCompleted;
    const completed = new Promise((resolve) => {
      oldCompleted = resolve;
    });
    const complete = h.processor.onInvocationComplete.bind(h.processor);
    h.processor.onInvocationComplete = async (...args) => {
      await complete(...args);
      oldCompleted();
    };
    let injectReadFailure = false;
    const restore = h.queue.restoreClaimedEntries.bind(h.queue);
    h.queue.restoreClaimedEntries = async (...args) => {
      finishTeardown();
      await completed;
      assert.equal(h.processor.hasProcessingSlotReservation('thread', 'opus', oldExecutionId), false);
      const restored = await restore(...args);
      injectReadFailure = true;
      return restored;
    };
    const read = h.messages.getById.bind(h.messages);
    let failedReads = 0;
    h.messages.getById = (id) => {
      if (injectReadFailure && id === next.message.id && failedReads < failures) {
        failedReads += 1;
        throw new Error('temporary source read failure');
      }
      return read(id);
    };
    const response = await h.app.inject({
      method: 'POST',
      url: `/api/threads/thread/queue/${next.entry.id}/${legacy ? 'steer' : 'targets'}`,
      headers: { 'x-cat-cafe-user': 'owner' },
      payload: legacy
        ? { mode: 'immediate' }
        : {
            sourceRecordId: next.message.id,
            observedPendingTargetIds: ['opus'],
            targets: [{ targetCatId: 'opus', strategy: 'interrupt_reply', membershipAtOpen: 'member' }],
          },
    });
    assert.equal(response.statusCode, 200, response.body);
    assert.equal(legacy ? response.json().outcome : response.json().targets[0].result.outcome, 'queued');
    await waitFor(() => h.starts.includes('new input') && !h.processor.isThreadBusy('thread'));
    assert.equal(failedReads, failures);
    assert.equal(h.starts.filter((content) => content === 'new input').length, 1);
    assert.equal(h.messages.getById(next.message.id).content, 'new input');
    assert.equal(await h.queue.getDurableEntry('thread', next.entry.id), null);
    assert.equal(h.events.filter((event) => event.type === 'error').length, 0);
  });
});

test('#2008 a failed source keeps its own retry while another member starts', async (t) => {
  const h = await stopFixture(t, { idle: true, retryDeferral: { baseDelayMs: 20 } });
  const blocked = await h.send('temporarily unreadable', ['opus']);
  const other = await h.send('other member input', ['codex']);
  const read = h.messages.getById.bind(h.messages);
  let failedReads = 0;
  h.messages.getById = (id) => {
    if (id === blocked.message.id && failedReads < 2) {
      failedReads += 1;
      throw new Error('temporary source read failure');
    }
    return read(id);
  };
  await h.processor.requestDrain('thread');
  await waitFor(() => h.starts.length === 2 && !h.processor.isThreadBusy('thread'));
  assert.deepEqual(h.starts, [other.message.content, blocked.message.content]);
  assert.equal(failedReads, 2);
  assert.equal(h.queue.list('thread', 'owner').length, 0);
  assert.equal(h.events.filter((event) => event.type === 'error').length, 0);
});
