import assert from 'node:assert/strict';
import { test } from 'node:test';
import { stopFixture, waitFor } from './helpers/stop-private-fixture.js';

for (const phase of ['selection', 'reconciliation']) {
  for (const failures of [1, 2]) {
    test(`#2008 queued admission retains its wake: ${phase}, faults=${failures}`, async (t) => {
      const h = await stopFixture(t, { idle: true, retryDeferral: { baseDelayMs: 20 } });
      let finishTeardown;
      const teardown = new Promise((resolve) => {
        finishTeardown = resolve;
      });
      t.after(() => finishTeardown());
      const route = h.processor.deps.router.routeExecution;
      const recipients = [];
      h.processor.deps.router.routeExecution = async function* (...args) {
        if (args[1] === 'new input') recipients.push(...args[4]);
        yield* route(...args);
        if (args[1] === 'active') await teardown;
      };
      await h.send('active');
      await h.processor.requestDrain('thread');
      await waitFor(() => h.starts.length === 1);
      const next = await h.send('new input', ['opus', 'codex']);
      let oldCompleted;
      const completed = new Promise((resolve) => {
        oldCompleted = resolve;
      });
      const complete = h.processor.onInvocationComplete.bind(h.processor);
      h.processor.onInvocationComplete = async (...args) => {
        await complete(...args);
        oldCompleted();
      };
      const restore = h.queue.restoreClaimedEntries.bind(h.queue);
      let restored = false;
      h.queue.restoreClaimedEntries = async (...args) => {
        finishTeardown();
        await completed;
        const result = await restore(...args);
        restored = true;
        return result;
      };
      const method =
        phase === 'selection' ? 'firstTargetWithExistingReceiver' : 'reconcileClaimedGroupWithExistingReceiver';
      const inspect = h.processor[method].bind(h.processor);
      let inspecting = false;
      h.processor[method] = async (...args) => {
        inspecting = true;
        try {
          return await inspect(...args);
        } finally {
          inspecting = false;
        }
      };
      const read = h.messages.getById.bind(h.messages);
      let injected = 0;
      h.messages.getById = (id) => {
        if (restored && inspecting && id === next.message.id && injected < failures) {
          injected += 1;
          throw new Error(`temporary ${phase} receiver read failure`);
        }
        return read(id);
      };
      const response = await h.app.inject({
        method: 'POST',
        url: `/api/threads/thread/queue/${next.entry.id}/steer`,
        headers: { 'x-cat-cafe-user': 'owner' },
        payload: { mode: 'immediate' },
      });
      assert.equal(response.statusCode, 200, response.body);
      assert.equal(response.json().outcome, 'queued');
      await waitFor(() => h.starts.includes('new input') && !h.processor.isThreadBusy('thread'));
      assert.equal(injected, failures, 'the fault reaches the real receiver read');
      assert.equal(h.starts.filter((value) => value === 'new input').length, 1);
      assert.deepEqual(recipients.sort(), ['codex', 'opus']);
      assert.equal(await h.queue.getDurableEntry('thread', next.entry.id), null);
      assert.equal(h.messages.getById(next.message.id).content, 'new input');
      assert.equal(h.events.filter((event) => event.type === 'error').length, 0);
    });
  }
}

test('#2008 a failed targetless failure-history read preserves the original error and a future wake', async (t) => {
  const h = await stopFixture(t, { idle: true, retryDeferral: { baseDelayMs: 20 } });
  h.processor.deps.router.resolveConversationTargetsAtAdmission = async () => ['opus'];
  const next = await h.send('targetless input', []);
  const read = h.messages.getByIdempotencyKey.bind(h.messages);
  const failure = new Error('temporary failure-history read failure');
  let injected = 0;
  h.messages.getByIdempotencyKey = (...args) => {
    if (args[2].includes(next.entry.id) && injected === 0) {
      injected += 1;
      throw failure;
    }
    return read(...args);
  };
  await assert.rejects(h.processor.requestDrain('thread'), (error) => error === failure);
  await waitFor(() => h.starts.includes('targetless input') && !h.processor.isThreadBusy('thread'));
  assert.equal(injected, 1);
  assert.deepEqual(h.starts, ['targetless input']);
  assert.equal(await h.queue.getDurableEntry('thread', next.entry.id), null);
});
