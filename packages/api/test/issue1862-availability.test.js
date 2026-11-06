import assert from 'node:assert/strict';
import { test } from 'node:test';
import { queueHttpFixture } from './helpers/1398-queue-http-fixture.js';
import { runDispatch, waitFor } from './helpers/issue1862-dispatch-fixture.js';

const bootstrapUnavailable = {
  code: 'ACP_BOOTSTRAP_UNAVAILABLE',
  message: 'fixture: ACP bootstrap is temporarily unavailable',
};

function observeReply(catId, launches) {
  return async function* () {
    launches.push(catId);
    yield { type: 'text', catId, content: 'Read the exact Queue work', timestamp: Date.now() };
    yield { type: 'done', catId, timestamp: Date.now() };
  };
}

test('a retired target with lost acknowledgement still wakes an idle caller on this worker', async (t) => {
  const f = await queueHttpFixture(t);
  const launches = [];
  f.agents.get('codex').invoke = observeReply('codex', launches);
  const commit = f.messages.commitLifecyclePreAdmissionFailure.bind(f.messages);
  f.messages.commitLifecyclePreAdmissionFailure = (...args) => {
    const result = commit(...args);
    if (result.kind === 'applied') throw new Error('fixture: retired target lost acknowledgement');
    return result;
  };
  const { threadId, entry, queue, messages, invocationTracker } = await runDispatch(t, {
    f,
    unavailable: true,
    busyCaller: false,
    drainError: /retired target lost acknowledgement/,
  });
  assert.equal(await queue.getDurableEntry(threadId, entry.id), null);
  await waitFor(() => launches.length === 1 && !invocationTracker.has(threadId, 'codex'));
  const history = await messages.getByThread(threadId);
  assert.equal(history.filter((row) => row.lifecycle?.kind === 'delivery_failure').length, 1);
  assert.deepEqual(await queue.listAllDurable(threadId), []);
});

test('an already enqueued target survives temporary bootstrap unavailability', async (t) => {
  const { agents, messages, queue, router, processor, threadId, userId, entry, target, invocationTracker } =
    await runDispatch(t, { unavailable: bootstrapUnavailable.code });
  const pending = await queue.getDurableEntry(threadId, entry.id);
  assert.equal(pending?.status, 'queued');
  const history = await messages.getByThread(threadId);
  assert.equal(
    history.some((row) => row.lifecycle?.kind === 'delivery_failure'),
    false,
  );
  const launches = [];
  agents.register(target, { invoke: observeReply(target, launches) });
  router.refreshFromRegistry(agents);
  await processor.processNext(threadId, userId);
  await waitFor(() => launches.length === 1 && !invocationTracker.has(threadId, target));
  assert.deepEqual(await queue.listAllDurable(threadId), []);
});

test('a durable failure wake survives temporary caller bootstrap unavailability', async (t) => {
  const { agents, queue, router, processor, threadId, userId, caller, invocationTracker } = await runDispatch(t);
  const [wake] = await queue.listAllDurable(threadId);
  agents.markUnavailable(caller, bootstrapUnavailable);
  router.refreshFromRegistry(agents);
  invocationTracker.complete(threadId, caller);
  await processor.requestDrain(threadId);
  assert.equal((await queue.getDurableEntry(threadId, wake.id))?.status, 'queued');
  const launches = [];
  agents.register(caller, { invoke: observeReply(caller, launches) });
  router.refreshFromRegistry(agents);
  await processor.processNext(threadId, userId);
  await waitFor(() => launches.length === 1 && !invocationTracker.has(threadId, caller));
  assert.deepEqual(await queue.listAllDurable(threadId), []);
});
