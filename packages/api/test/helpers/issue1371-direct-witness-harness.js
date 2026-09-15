import assert from 'node:assert/strict';
import { mock } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import Fastify from 'fastify';
import { InvocationQueue } from '../../dist/domains/cats/services/agents/invocation/InvocationQueue.js';
import { InvocationRegistry } from '../../dist/domains/cats/services/agents/invocation/InvocationRegistry.js';
import { InvocationTracker } from '../../dist/domains/cats/services/agents/invocation/InvocationTracker.js';
import {
  createInitialQueuedMessageCustody,
  QueuedMessageCustodyCoordinator,
} from '../../dist/domains/cats/services/agents/invocation/QueuedMessageCustodyCoordinator.js';
import { QueueProcessor } from '../../dist/domains/cats/services/agents/invocation/QueueProcessor.js';
import { InMemoryTurnExecutionStore } from '../../dist/domains/cats/services/stores/memory/InMemoryTurnExecutionStore.js';
import { InvocationRecordStore } from '../../dist/domains/cats/services/stores/ports/InvocationRecordStore.js';
import { MessageStore } from '../../dist/domains/cats/services/stores/ports/MessageStore.js';
import { generateScriptViaThread } from '../../dist/domains/signals/services/podcast-generator.js';
import { ConnectorInvokeTrigger } from '../../dist/infrastructure/email/ConnectorInvokeTrigger.js';
import { triggerA2AInvocation } from '../../dist/routes/callback-a2a-trigger.js';
import { invocationsRoutes } from '../../dist/routes/invocations.js';
import { messagesRoutes } from '../../dist/routes/messages.js';
import { queueRoutes } from '../../dist/routes/queue.js';

// Real HTTP ingress, QueueProcessor, custody CAS, and parent/child stores. The
// route event stream substitutes only for provider execution, not settlement.
export async function runDirectWitnessScenario(
  t,
  {
    ingress = 'message',
    messageUserId = 'scheduler',
    proof = 'exact',
    messageStore = new MessageStore(),
    useHttp = false,
  } = {},
) {
  const threadId = 'thread-direct-witness';
  const userId = 'user-1';
  const authorCat = ingress === 'podcast' ? 'opus' : 'codex';
  const reviewerCat = authorCat === 'opus' ? 'codex' : 'opus';
  const invocationQueue = new InvocationQueue();
  const invocationTracker = new InvocationTracker();
  const invocationRecordStore = new InvocationRecordStore();
  const turnExecutionStore = new InMemoryTurnExecutionStore();
  const queueCustodyCoordinator = new QueuedMessageCustodyCoordinator({ messageStore });
  const socketManager = { broadcastAgentMessage() {}, broadcastToRoom() {}, emitToUser() {} };
  const log = { info: mock.fn(), warn: mock.fn(), error: mock.fn(), debug: mock.fn() };
  const holds = [];
  const calls = [];
  const completions = [];
  let review;
  let parentId;

  async function enqueue(content, { taskId, catId = authorCat } = {}) {
    const entry = invocationQueue.enqueue({
      threadId,
      userId,
      ownerAuthProvenance: 'unknown',
      content,
      source: taskId ? 'connector' : 'agent',
      sourceCategory: taskId ? 'scheduled' : 'a2a',
      targetCats: [catId],
      intent: 'execute',
      autoExecute: true,
    }).entry;
    assert.ok(entry);
    const message = await messageStore.append({
      threadId,
      userId: taskId ? messageUserId : userId,
      catId: taskId ? null : authorCat,
      content,
      mentions: [catId],
      timestamp: entry.createdAt,
      deliveryStatus: 'queued',
      queueCustody: createInitialQueuedMessageCustody(entry),
      ...(taskId
        ? {
            source: {
              connector: 'hold-ball',
              label: '持球通知',
              icon: 'timer',
              meta: { taskId, threadId, catId, wakeWhen: true },
            },
          }
        : {}),
    });
    invocationQueue.backfillMessageId(threadId, userId, entry.id, message.id);
    return { entry, message };
  }

  const router = {
    resolveTargetsAndIntent: async () => ({
      targetCats: [authorCat],
      intent: { intent: 'execute', explicit: true, promptTags: [] },
    }),
    ackCollectedCursors: async () => {},
    routeExecution: async function* (_userId, _content, _threadId, triggerId, targets, _intent, opts) {
      calls.push([...targets]);
      const catId = targets[0];
      const childId = `child-${catId}-${calls.length}`;
      if (catId === authorCat) parentId = opts.parentInvocationId;
      turnExecutionStore.createRunning({
        invocationId: childId,
        parentInvocationId: opts.parentInvocationId,
        threadId,
        userId,
        catId,
        executionKind: 'ordinary',
        startedAt: Date.now(),
      });
      yield {
        type: 'system_info',
        catId,
        invocationId: childId,
        timestamp: Date.now(),
        content: JSON.stringify({
          type: 'invocation_created',
          invocationId: childId,
          parentInvocationId: opts.parentInvocationId,
          executionKind: 'ordinary',
          startedAt: Date.now(),
        }),
      };
      let witnesses;
      if (catId === authorCat) {
        assert.equal(calls.length, 1, 'an already handled command must never re-enter the provider');
        holds.push(await enqueue('gate complete one', { taskId: 'task-one' }));
        holds.push(await enqueue('gate complete two', { taskId: 'task-two' }));
        review = await enqueue('please review the finished change', { catId: reviewerCat });
        const adopted = await opts.onPromptMessagesExposed({
          threadId,
          userId,
          catId,
          invocationId: childId,
          messageIds: holds.map(({ message }) => message.id),
          seenAt: Date.now(),
        });
        assert.equal(adopted.length, 2, 'both exact managed wakes were exposed to this child');
        witnesses = adopted.map((wake) => ({
          kind: 'managed_hold_continued',
          sourceMessageId: wake.sourceMessageId,
          taskId: wake.taskId,
          transition: 'transferred',
        }));
        if (proof === 'missing') witnesses = undefined;
        if (proof === 'wrong source') witnesses = witnesses.map((w) => ({ ...w, sourceMessageId: 'foreign-source' }));
        if (proof === 'wrong task') witnesses = witnesses.map((w) => ({ ...w, taskId: 'foreign-task' }));
      } else {
        assert.equal(triggerId, review.message.id);
        await opts.onPromptMessagesExposed({
          threadId,
          userId,
          catId,
          invocationId: childId,
          messageIds: [triggerId],
          seenAt: Date.now(),
        });
      }
      turnExecutionStore.transitionTerminal(childId, { status: 'succeeded', endedAt: Date.now() });
      if (ingress === 'podcast') {
        yield {
          type: 'text',
          catId,
          content: '{"segments":[{"speaker":"宪宪","text":"测试","durationEstimate":3}],"totalDuration":3}',
        };
      }
      yield {
        type: 'done',
        catId,
        invocationId: proof === 'wrong child' ? 'foreign-child' : childId,
        isFinal: true,
        timestamp: Date.now(),
        ...(witnesses ? { turnCustodyTerminalWitness: witnesses[0], turnCustodyTerminalWitnesses: witnesses } : {}),
      };
    },
  };
  const processor = new QueueProcessor({
    queue: invocationQueue,
    invocationTracker,
    invocationRecordStore,
    messageStore,
    queueCustodyCoordinator,
    turnExecutionStore,
    router,
    socketManager,
    log,
  });
  const complete = processor.onInvocationComplete.bind(processor);
  processor.onInvocationComplete = (...args) => {
    const completion = complete(...args);
    completions.push(completion);
    return completion;
  };
  const executionDeps = {
    router,
    invocationRecordStore,
    invocationTracker,
    invocationQueue,
    queueProcessor: processor,
    queueCustodyCoordinator,
    messageStore,
    socketManager,
    log,
  };
  const app = Fastify();
  t.after(() => app.close());
  const threadStore = { get: async () => ({ id: threadId, createdBy: userId }) };
  await app.register(messagesRoutes, {
    registry: new InvocationRegistry(),
    router,
    messageStore,
    socketManager,
    invocationTracker,
    invocationQueue,
    invocationRecordStore,
    queueProcessor: processor,
    threadStore,
  });
  await app.register(queueRoutes, {
    threadStore,
    invocationQueue,
    invocationTracker,
    queueProcessor: processor,
    queueCustodyCoordinator,
    messageStore,
    socketManager,
  });
  await app.register(invocationsRoutes, {
    invocationRecordStore,
    messageStore,
    socketManager,
    router,
    invocationTracker,
    queueProcessor: processor,
  });
  const address = useHttp ? await app.listen({ host: '127.0.0.1', port: 0 }) : undefined;
  async function request(options) {
    if (!address) return app.inject(options);
    const response = await fetch(address + options.url, {
      method: options.method,
      headers: { ...options.headers, 'content-type': 'application/json' },
      ...(options.payload ? { body: JSON.stringify(options.payload) } : {}),
    });
    const body = await response.text();
    return { statusCode: response.status, body, json: () => JSON.parse(body) };
  }
  if (ingress === 'message') {
    const response = await request({
      method: 'POST',
      url: '/api/messages',
      headers: { 'x-cat-cafe-user': userId },
      payload: { threadId, content: 'continue the authorized fix', targetCats: ['codex'] },
    });
    assert.equal(response.statusCode, 200, response.body);
  } else if (ingress === 'podcast') {
    await generateScriptViaThread(
      {
        articleId: 'direct-witness',
        articleFilePath: '/tmp/issue1371-article.md',
        articleTitle: 'Queue evidence',
        articleContent: 'An exact adopted completion.',
        mode: 'essence',
        requestedBy: userId,
      },
      threadId,
      executionDeps,
    );
  } else {
    const source = await messageStore.append({
      threadId,
      userId,
      catId: ingress === 'standalone A2A' ? 'opus' : null,
      content: 'continue the authorized fix',
      mentions: ['codex'],
      timestamp: Date.now(),
    });
    if (ingress === 'retry') {
      const created = invocationRecordStore.create({
        threadId,
        userId,
        targetCats: ['codex'],
        intent: 'execute',
        idempotencyKey: 'retry-parent',
        actionLeaseCarrier: { kind: 'none' },
      });
      invocationRecordStore.update(created.invocationId, { status: 'running', userMessageId: source.id });
      invocationRecordStore.update(created.invocationId, { status: 'failed', error: 'prior provider failure' });
      const response = await request({
        method: 'POST',
        url: `/api/invocations/${created.invocationId}/retry`,
        headers: { 'x-cat-cafe-user': userId },
      });
      assert.equal(response.statusCode, 202, response.body);
    } else if (ingress === 'connector') {
      const trigger = new ConnectorInvokeTrigger(executionDeps);
      assert.equal(await trigger.trigger(threadId, 'codex', userId, source.content, source.id), 'dispatched');
    } else {
      await triggerA2AInvocation(executionDeps, {
        targetCats: ['codex'],
        userId,
        ownerAuthProvenance: 'unknown',
        threadId,
        content: source.content,
        triggerMessage: source,
      });
    }
  }
  async function waitUntil(predicate, reason) {
    const deadline = Date.now() + 5000;
    while (!predicate() && Date.now() < deadline) await delay(10);
    assert.ok(predicate(), reason);
  }
  await waitUntil(() => completions.length > 0, 'direct route must complete');
  await completions[0];
  assert.equal(invocationRecordStore.get(parentId).status, 'succeeded');
  assert.equal(holds.length, 2);
  if (proof !== 'exact') {
    assert.deepEqual(calls, [[authorCat]], 'invalid evidence cannot authorize source consumption or blind retry');
    for (const { message } of holds) {
      const custody = (await messageStore.getById(message.id)).queueCustody;
      assert.equal(custody.status, 'queued');
      assert.deepEqual(custody.handledByCatIds, []);
    }
    return;
  }
  for (const { message } of holds) {
    const settled = await messageStore.getById(message.id);
    assert.equal(settled.queueCustody.status, 'terminal', 'adopted command receipt must settle before dequeue');
    assert.equal(settled.queueCustody.targetOutcomeByCatId[authorCat].disposition, 'managed_hold_disposition');
    assert.equal(settled.queueCustody.targetOutcomeByCatId[authorCat].consumption.sourceMessageId, message.id);
  }
  await waitUntil(() => invocationQueue.list(threadId, userId).length === 0, 'review must drain the queue');
  await Promise.all(completions);
  assert.deepEqual(calls, [[authorCat], [reviewerCat]], 'review starts once, with no Steer or repeat command');
  assert.deepEqual(invocationQueue.list(threadId, userId), []);
  const snapshot = await request({
    method: 'GET',
    url: `/api/threads/${threadId}/queue`,
    headers: { 'x-cat-cafe-user': userId },
  });
  assert.deepEqual(snapshot.json().queue, []);
  assert.equal(log.error.mock.calls.length, 0);
  return { sourceMessageIds: holds.map(({ message }) => message.id), calls };
}
