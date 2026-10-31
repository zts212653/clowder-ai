import assert from 'node:assert/strict';
import Fastify from 'fastify';
import './setup-cat-registry.js';
import { InvocationQueue } from '../../dist/domains/cats/services/agents/invocation/InvocationQueue.js';
import { InvocationRegistry } from '../../dist/domains/cats/services/agents/invocation/InvocationRegistry.js';
import { InvocationTracker } from '../../dist/domains/cats/services/agents/invocation/InvocationTracker.js';
import { QueueProcessor } from '../../dist/domains/cats/services/agents/invocation/QueueProcessor.js';
import { InMemoryTurnExecutionStore } from '../../dist/domains/cats/services/stores/memory/InMemoryTurnExecutionStore.js';
import { DeliveryCursorStore } from '../../dist/domains/cats/services/stores/ports/DeliveryCursorStore.js';
import { MessageStore } from '../../dist/domains/cats/services/stores/ports/MessageStore.js';
import { TaskStore } from '../../dist/domains/cats/services/stores/ports/TaskStore.js';
import { LiveCarrierOperationGate } from '../../dist/domains/concierge/live/LiveCarrierOperationGate.js';
import { callbacksRoutes } from '../../dist/routes/callbacks.js';
import { appendTestLifecycleResponseSource } from './message-from-fixtures.js';

/** Complete compiled callback/Queue/History composition with an exact authenticated active turn. */
export async function createCallbackContextFixture(t, options = {}) {
  const userId = 'isolated-context-owner';
  const threadId = 'isolated-context-thread';
  const catId = 'opus';
  const registry = new InvocationRegistry();
  const parent = await registry.create(userId, catId, threadId);
  const auth = options.live ? await registry.create(userId, catId, threadId, parent.invocationId) : parent;
  const gate = options.live ? new LiveCarrierOperationGate() : undefined;
  const tasks = new TaskStore();
  const queue = new InvocationQueue();
  const messages = new MessageStore();
  const executions = new InMemoryTurnExecutionStore();
  const tracker = new InvocationTracker();
  const cursors = new DeliveryCursorStore();
  await executions.createRunning({
    invocationId: auth.invocationId,
    parentInvocationId: parent.invocationId,
    userId,
    threadId,
    catId,
    executionKind: 'ordinary',
    ...(options.live ? { queueCompletionPolicy: 'explicit_source' } : {}),
    startedAt: Date.now(),
  });
  tracker.start(threadId, catId, userId, [catId], parent.invocationId);
  const response = appendTestLifecycleResponseSource(messages, {
    userId,
    threadId,
    catId,
    invocationId: auth.invocationId,
    timestamp: Date.now(),
  });
  assert.equal(
    tracker.bindLifecycleActiveRun(
      {
        threadId,
        targetId: catId,
        invocationId: auth.invocationId,
        responseMessageId: response.id,
        inputEntryIds: [],
        inputMessageIds: [],
        privateInputEntryIds: [],
        startedAt: Date.now(),
      },
      parent.invocationId,
    ),
    true,
  );
  const processor = new QueueProcessor({
    queue,
    invocationTracker: tracker,
    messageStore: messages,
    invocationRecordStore: {},
    router: {},
    socketManager: { emitToUser() {}, broadcastToRoom() {}, broadcastAgentMessage() {} },
    log: { info() {}, warn() {}, error() {} },
  });
  const app = Fastify();
  await app.register(callbacksRoutes, {
    registry,
    messageStore: messages,
    invocationQueue: queue,
    invocationTracker: tracker,
    turnExecutionStore: executions,
    queueProcessor: processor,
    deliveryCursorStore: cursors,
    taskStore: tasks,
    ...(gate ? { withLiveCarrierOperation: (query, consume) => gate.runForCarrier(query, consume) } : {}),
    ...options.callbackOptions,
    socketManager: { emitToUser() {}, broadcastToRoom() {}, broadcastAgentMessage() {} },
  });
  t.after(() => app.close());
  const read = (args = {}) =>
    app.inject({
      method: 'GET',
      url: `/api/callbacks/thread-context?${new URLSearchParams({ responseMode: 'full', ...args })}`,
      headers: { 'x-invocation-id': auth.invocationId, 'x-callback-token': auth.callbackToken },
    });
  const publish = (content, extra = {}) =>
    messages.append({
      userId,
      threadId,
      from: { kind: 'user', userId },
      content,
      mentions: [],
      timestamp: Date.now(),
      ...extra,
    });
  const enqueue = (content = 'owned queued context body', extra = {}, messageExtra = {}) =>
    queue.send(
      messages,
      {
        userId,
        threadId,
        from: { kind: 'user', userId },
        content,
        mentions: ['opus', 'codex'],
        deliveryStatus: 'queued',
        timestamp: Date.now(),
        ...messageExtra,
      },
      {
        userId,
        threadId,
        from: { kind: 'user', userId },
        content,
        targetCats: ['opus', 'codex'],
        kind: 'conversation_input',
        intent: 'execute',
        ownerAuthProvenance: 'strict',
        authorIntentByCatId: { opus: { requested: 'continue_current', boundParentInvocationId: parent.invocationId } },
        ...extra,
      },
    );
  return {
    app,
    read,
    publish,
    enqueue,
    registry,
    auth,
    parent,
    gate,
    tasks,
    queue,
    messages,
    executions,
    tracker,
    cursors,
    processor,
    response,
    userId,
    threadId,
  };
}
