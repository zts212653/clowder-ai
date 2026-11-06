import assert from 'node:assert/strict';
import { mock } from 'node:test';
import Fastify from 'fastify';
import { InvocationQueue } from '../../dist/domains/cats/services/agents/invocation/InvocationQueue.js';
import { InvocationTracker } from '../../dist/domains/cats/services/agents/invocation/InvocationTracker.js';
import { QueueProcessor } from '../../dist/domains/cats/services/agents/invocation/QueueProcessor.js';
import { lifecycleResponseIdempotencyKey } from '../../dist/domains/cats/services/agents/invocation/response-draft-settlement.js';
import { InMemoryTurnExecutionStore } from '../../dist/domains/cats/services/stores/memory/InMemoryTurnExecutionStore.js';
import { InvocationRecordStore } from '../../dist/domains/cats/services/stores/ports/InvocationRecordStore.js';
import { MessageStore } from '../../dist/domains/cats/services/stores/ports/MessageStore.js';
import { queueRoutes } from '../../dist/routes/queue.js';

/** Real HTTP route and lifecycle stores; only the unavailable owner and failure boundary are controlled. */
export async function readRepairFixture(t, turnExecutionStore = new InMemoryTurnExecutionStore()) {
  let now = 1_800_000_000_000;
  t.mock.method(Date, 'now', () => now);
  const threadId = 'retry-thread';
  const userId = 'retry-user';
  const catId = 'opus';
  const invocationQueue = new InvocationQueue();
  const invocationTracker = new InvocationTracker();
  const invocationRecordStore = new InvocationRecordStore();
  const messageStore = new MessageStore();
  const logs = [];
  const socketManager = {
    broadcastAgentMessage: mock.fn(),
    broadcastToRoom: mock.fn(),
    emitToUser: mock.fn(),
  };
  const queueProcessor = new QueueProcessor({
    queue: invocationQueue,
    invocationTracker,
    invocationRecordStore,
    turnExecutionStore,
    messageStore,
    router: {},
    socketManager,
    log: { info: mock.fn(), warn: mock.fn(), error: mock.fn() },
  });
  const thread = { id: threadId, title: 'Read repair', projectPath: '/retry-project', createdBy: userId };
  const h = {
    threadId,
    userId,
    catId,
    invocationTracker,
    invocationRecordStore,
    turnExecutionStore,
    invocationQueue,
    queueProcessor,
    socketManager,
    logs,
    owners: [],
    ownerComplete: true,
    slot: false,
    failure: undefined,
    beforeTransition: undefined,
    advance(ms) {
      now += ms;
    },
    errors() {
      return logs.filter((line) => line.level === 50 && line.msg === 'active execution read-repair failed closed');
    },
  };
  t.mock.method(queueProcessor, 'hasProcessingSlotReservation', () => h.slot);
  const transition = turnExecutionStore.transitionTerminal.bind(turnExecutionStore);
  h.transition = t.mock.method(turnExecutionStore, 'transitionTerminal', async (...args) => {
    await h.beforeTransition?.();
    if (h.failure) throw h.failure;
    return transition(...args);
  });
  h.addExecution = async (key) => {
    const { invocationId: id } = invocationRecordStore.create({
      threadId,
      userId,
      targetCats: [catId],
      intent: 'execute',
      idempotencyKey: key,
      actionLeaseCarrier: { kind: 'none' },
    });
    invocationRecordStore.update(id, { status: 'running' });
    const childId = `child-${key}`;
    await turnExecutionStore.createRunning({
      invocationId: childId,
      parentInvocationId: id,
      threadId,
      userId,
      catId,
      executionKind: 'ordinary',
      startedAt: now,
      providerLifecycleTracked: true,
    });
    await turnExecutionStore.markProviderStarted(childId, now);
    // An admitted ordinary turn has a processing R for recovery to settle after provider teardown.
    await messageStore.append({
      from: { kind: 'agent', catId },
      userId,
      threadId,
      content: '',
      mentions: [],
      origin: 'stream',
      timestamp: now,
      idempotencyKey: lifecycleResponseIdempotencyKey(childId),
      extra: { stream: { invocationId: id, turnInvocationId: childId } },
      lifecycle: {
        kind: 'response',
        orderKey: `${now}:${childId}`,
        invocationId: childId,
        targetId: catId,
        inputEntryIds: [],
        inputMessageIds: [],
        status: 'processing',
        startedAt: now,
      },
    });
    return { parent: invocationRecordStore.get(id), childId };
  };
  Object.assign(h, await h.addExecution('original'));
  h.advance(60_000);
  const app = Fastify({ logger: { level: 'info', stream: { write: (line) => logs.push(JSON.parse(line)) } } });
  await app.register(queueRoutes, {
    threadStore: { get: async () => thread, list: async () => [thread], listByProject: async () => [thread] },
    invocationQueue,
    invocationTracker,
    invocationRecordStore,
    turnExecutionStore,
    messageStore,
    queueProcessor,
    socketManager,
    cliExecutionOwnerService: { listLive: async () => ({ owners: [...h.owners], complete: h.ownerComplete }) },
    agentSessionMutex: { forceReleaseByScope: () => ({ releasedHolders: 0, rejectedWaiters: 0, catIds: [] }) },
  });
  await app.ready();
  t.after(() => app.close());
  h.poll = async (scope = 'thread', expectedStatus = 200) => {
    const url =
      scope === 'thread'
        ? `/api/threads/${threadId}/executions/active`
        : scope === 'all'
          ? '/api/executions/active?scope=all'
          : '/api/executions/active?projectPath=%2Fretry-project';
    const response = await app.inject({ method: 'GET', url, headers: { 'x-cat-cafe-user': userId } });
    if (expectedStatus !== null) assert.equal(response.statusCode, expectedStatus, response.body);
    return response;
  };
  return h;
}
