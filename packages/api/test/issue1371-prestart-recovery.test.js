import assert from 'node:assert/strict';
import { mock, test } from 'node:test';
import Fastify from 'fastify';
import { InvocationQueue } from '../dist/domains/cats/services/agents/invocation/InvocationQueue.js';
import { InvocationTracker } from '../dist/domains/cats/services/agents/invocation/InvocationTracker.js';
import { QueueProcessor } from '../dist/domains/cats/services/agents/invocation/QueueProcessor.js';
import {
  commitLifecycleResponseFromAppendInput,
  MessageStore,
} from '../dist/domains/cats/services/stores/ports/MessageStore.js';
import { queueRoutes } from '../dist/routes/queue.js';
import { canonicalTestMessageInput, canonicalTestQueueInput } from './helpers/message-from-fixtures.js';

async function waitFor(predicate) {
  const until = Date.now() + 2_000;
  while (!(await predicate())) {
    if (Date.now() > until) throw new Error('Queue did not converge');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

async function harness() {
  const queue = new InvocationQueue();
  const tracker = new InvocationTracker();
  const store = new MessageStore();
  let releaseCreate;
  const createGate = new Promise((resolve) => {
    releaseCreate = resolve;
  });
  let created = 0;
  const recordMap = new Map();
  const records = {
    create: mock.fn(async (input) => {
      const invocationId = `inv-${++created}`;
      if (created === 1) await createGate;
      const record = {
        id: invocationId,
        ...input,
        userMessageId: null,
        status: 'queued',
        createdAt: Date.now(),
        updatedAt: Date.now(),
      };
      recordMap.set(invocationId, record);
      return { outcome: 'created', invocationId };
    }),
    get: async (id) => recordMap.get(id) ?? null,
    update: async (id, patch) => {
      const current = recordMap.get(id);
      if (!current) return null;
      if (patch.expectedStatus && current.status !== patch.expectedStatus) return null;
      const { expectedStatus: _expectedStatus, ...changes } = patch;
      const next = { ...current, ...changes, updatedAt: Date.now() };
      recordMap.set(id, next);
      return next;
    },
    listRunningByThread: async () => [],
  };
  const socketManager = { emitToUser: mock.fn(), broadcastToRoom() {}, broadcastAgentMessage() {} };
  const routeExecution = mock.fn(async function* (userId, _content, threadId, messageId, targets, _intent, options) {
    for (const catId of targets) {
      const childId = `child-${created}-${catId}`;
      const lifecycleAdmission = await options.onLifecycleInvocationStarted({
        threadId,
        userId,
        catId,
        invocationId: childId,
        parentInvocationId: options.parentInvocationId,
        startedAt: Date.now(),
      });
      await options.onPromptMessagesExposed({
        threadId,
        userId,
        catId,
        invocationId: childId,
        messageIds: [messageId],
        seenAt: Date.now(),
      });
      await commitLifecycleResponseFromAppendInput(
        store,
        lifecycleAdmission.responseMessageId,
        childId,
        { status: 'completed', completedAt: Date.now() },
        {
          from: { kind: 'agent', catId },
          userId,
          threadId,
          content: 'handled exact source',
          mentions: [],
          timestamp: Date.now(),
          replyTo: messageId,
          extra: {
            causal: { kind: 'invocation_reply', triggerMessageId: messageId },
            stream: { invocationId: `inv-${created}`, turnInvocationId: childId },
          },
        },
      );
      yield { type: 'done', catId, invocationId: childId, isFinal: true, timestamp: Date.now() };
    }
  });
  const processor = new QueueProcessor({
    queue,
    invocationTracker: tracker,
    messageStore: store,
    invocationRecordStore: records,
    socketManager,
    router: {
      resolveConversationTargetsAtAdmission: async (targets) => [...targets],
      resolveExplicitTargets: async (targets) => [...targets],
      routeExecution,
      ackCollectedCursors: async () => {},
    },
    log: { info: mock.fn(), warn: mock.fn(), error: mock.fn() },
  });
  const queueInput = canonicalTestQueueInput({
    threadId: 'thread-1',
    userId: 'user-1',
    kind: 'conversation_input',
    sourceId: 'issue1371-prestart-source',
    content: 'independent targets',
    targetCats: ['opus', 'codex'],
    intent: 'execute',
  });
  const admitted = await queue.appendAndEnqueueDurable(
    store,
    canonicalTestMessageInput({
      threadId: queueInput.threadId,
      userId: queueInput.userId,
      from: queueInput.from,
      catId: null,
      mentions: queueInput.targetCats,
      content: queueInput.content,
      timestamp: Date.now(),
      deliveryStatus: 'queued',
    }),
    queueInput,
  );
  const source = admitted.message;
  const entry = admitted.entry;
  const app = Fastify();
  await app.register(queueRoutes, {
    threadStore: { get: async () => ({ id: 'thread-1', createdBy: 'user-1' }) },
    invocationQueue: queue,
    invocationTracker: tracker,
    queueProcessor: processor,
    messageStore: store,
    invocationRecordStore: records,
    socketManager,
  });
  return {
    queue,
    tracker,
    store,
    processor,
    records,
    source,
    entry,
    routeExecution,
    releaseCreate,
    app,
  };
}

for (const entryPoint of ['direct', 'manual', 'automatic']) {
  test(`#1371: ${entryPoint} dispatch consumes one target and preserves the busy sibling`, async (t) => {
    const h = await harness();
    t.after(() => h.app.close());
    const busy = h.tracker.start('thread-1', 'opus', 'user-1', ['opus'], 'independent-work');

    if (entryPoint === 'direct') {
      const claimed = await h.queue.claimExactSteerEntryDurable('thread-1', 'user-1', h.entry.id, 'codex');
      assert.equal(claimed.outcome, 'claimed');
      const started = await h.processor.processClaimedSteerEntries(
        'thread-1',
        'user-1',
        claimed.entries.map((entry) => entry.id),
        'codex',
      );
      assert.equal(started.started, true);
    } else if (entryPoint === 'manual') {
      await h.processor.processNext('thread-1', 'user-1');
    } else {
      await h.processor.requestDrain('thread-1');
    }

    await waitFor(() => h.records.create.mock.calls.length === 1);
    h.releaseCreate();
    await waitFor(
      () => h.store.getById(h.source.id).lifecycle?.dispatchRefs?.some((ref) => ref.targetId === 'codex') === true,
    );
    assert.equal(busy.signal.aborted, false);
    assert.deepEqual(
      h.routeExecution.mock.calls.map((call) => call.arguments[4]),
      [['codex']],
    );
    assert.deepEqual(h.queue.getEntrySnapshot('thread-1', 'user-1', h.entry.id).targets, ['opus']);

    h.tracker.completeAll('thread-1', ['opus'], busy);
    await h.processor.processNext('thread-1', 'user-1');
    await waitFor(() => h.queue.list('thread-1', 'user-1').length === 0);
    assert.deepEqual(
      h.routeExecution.mock.calls.map((call) => call.arguments[4]),
      [['codex'], ['opus']],
    );
    assert.deepEqual(
      h.store
        .getById(h.source.id)
        .lifecycle.dispatchRefs.map((ref) => [ref.targetId, ref.phase])
        .sort(),
      [
        ['codex', 'settled'],
        ['opus', 'settled'],
      ],
    );
  });
}

test('#1371: force-reset retires a recordless pre-start target without running the provider', async (t) => {
  const h = await harness();
  t.after(() => h.app.close());
  await h.processor.processNext('thread-1', 'user-1');
  await waitFor(() => h.records.create.mock.calls.length === 1);

  const reset = await h.app.inject({
    method: 'POST',
    url: '/api/threads/thread-1/force-reset',
    headers: { 'x-cat-cafe-user': 'user-1' },
  });
  h.releaseCreate();
  assert.equal(reset.statusCode, 200, reset.body);
  assert.equal(h.routeExecution.mock.calls.length, 0);
  assert.deepEqual(h.queue.list('thread-1', 'user-1'), []);
  assert.equal(h.store.getById(h.source.id).deliveryStatus, 'canceled');
  assert.deepEqual(h.store.getById(h.source.id).lifecycle.dispatchRefs, []);
});

test('#1371: pre-start terminal write failure is visible and the exact retry succeeds', async (t) => {
  const h = await harness();
  t.after(() => h.app.close());
  await h.processor.processNext('thread-1', 'user-1');
  await waitFor(() => h.records.create.mock.calls.length === 1);
  const removeProcessed = h.queue.removeProcessedAcrossUsersDurable.bind(h.queue);
  h.queue.removeProcessedAcrossUsersDurable = async () => null;
  const request = {
    method: 'POST',
    url: '/api/threads/thread-1/force-reset',
    headers: { 'x-cat-cafe-user': 'user-1' },
  };
  const failed = await h.app.inject(request);
  assert.equal(failed.statusCode, 503, failed.body);
  h.queue.removeProcessedAcrossUsersDurable = removeProcessed;
  const retried = await h.app.inject(request);
  h.releaseCreate();
  assert.equal(retried.statusCode, 200, retried.body);
  assert.equal(h.routeExecution.mock.calls.length, 0);
  assert.deepEqual(h.queue.list('thread-1', 'user-1'), []);
});
