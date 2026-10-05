import assert from 'node:assert/strict';
import Fastify from 'fastify';
import { A2ADispatchDispositionService } from '../../dist/domains/ball-custody/A2ADispatchDispositionService.js';
import { buildHandedEvent } from '../../dist/domains/ball-custody/ball-custody-events.js';
import { DispatchAdoptionAuthority } from '../../dist/domains/ball-custody/DispatchAdoptionAuthority.js';
import { DispatchReceiptService } from '../../dist/domains/ball-custody/DispatchReceiptService.js';
import { turnCustodyAdoptionRegistry } from '../../dist/domains/ball-custody/TurnCustodyAdoptionRegistry.js';
import { InvocationQueue } from '../../dist/domains/cats/services/agents/invocation/InvocationQueue.js';
import { InvocationRegistry } from '../../dist/domains/cats/services/agents/invocation/InvocationRegistry.js';
import { InvocationTracker } from '../../dist/domains/cats/services/agents/invocation/InvocationTracker.js';
import {
  createInitialQueuedMessageCustody,
  QueuedMessageCustodyCoordinator,
} from '../../dist/domains/cats/services/agents/invocation/QueuedMessageCustodyCoordinator.js';
import { QueueProcessor } from '../../dist/domains/cats/services/agents/invocation/QueueProcessor.js';
import { InMemoryTurnExecutionStore } from '../../dist/domains/cats/services/stores/memory/InMemoryTurnExecutionStore.js';
import { callbacksRoutes } from '../../dist/routes/callbacks.js';
import { createA2ADispositionHarness } from './a2a-dispatch-disposition-harness.js';

export async function ordinaryDispatchFixture(t, { live = false } = {}) {
  const h = await createA2ADispositionHarness();
  const registry = new InvocationRegistry();
  const identity = await registry.create(
    'user-1',
    'codex-sol',
    'thread-1',
    undefined,
    h.source.id,
    undefined,
    h.source.id,
  );
  const executions = new InMemoryTurnExecutionStore();
  executions.createRunning({
    ...identity,
    parentInvocationId: identity.invocationId,
    userId: 'user-1',
    catId: 'codex-sol',
    threadId: 'thread-1',
    executionKind: 'ordinary',
    ...(live ? { queueCompletionPolicy: 'explicit_source' } : {}),
    startedAt: Date.now(),
  });
  const unregister = turnCustodyAdoptionRegistry.register(identity.invocationId, async () => {});
  const queue = new InvocationQueue();
  const coordinator = new QueuedMessageCustodyCoordinator({ messageStore: h.messageStore });
  const receipts = new DispatchReceiptService({
    messageStore: h.messageStore,
    queue,
    coordinator,
    eventLog: h.eventLog,
  });
  const service = new A2ADispatchDispositionService({
    registry,
    messageStore: h.messageStore,
    ballCustodyEventLog: h.eventLog,
    ballCustodyProjectionStore: h.projectionStore,
    ballCustody: h.ingest,
    adoptionAuthority: new DispatchAdoptionAuthority({
      executions,
      messages: h.messageStore,
      adoptions: turnCustodyAdoptionRegistry,
    }),
    projectAdoptedDisposition: async (input) => {
      assert.equal(await receipts.repair(input), true);
    },
  });
  const socketManager = { broadcastAgentMessage() {}, emitToUser() {}, broadcastToRoom() {} };
  const processor = new QueueProcessor({
    queue,
    messageStore: h.messageStore,
    queueCustodyCoordinator: coordinator,
    turnExecutionStore: executions,
    invocationTracker: new InvocationTracker(),
    invocationRecordStore: { async update() {} },
    router: {
      async *routeExecution() {
        throw new Error('must not start a provider');
      },
    },
    socketManager,
    repairDispatchReceipts: (input) => receipts.repairInvocation(input),
    log: { info() {}, warn() {}, error() {} },
  });
  const app = Fastify();
  await app.register(callbacksRoutes, {
    registry,
    messageStore: h.messageStore,
    invocationQueue: queue,
    queueProcessor: processor,
    queueCustodyCoordinator: coordinator,
    turnExecutionStore: executions,
    ballCustodyEventLog: h.eventLog,
    holdBallDeps: { registry, a2aDispatchDispositionService: service },
    socketManager,
  });
  const url = await app.listen({ port: 0, host: '127.0.0.1' });
  const headers = {
    'x-invocation-id': identity.invocationId,
    'x-callback-token': identity.callbackToken,
    'content-type': 'application/json',
  };
  t.after(async () => {
    await unregister();
    await app.close();
  });
  async function addSource(content) {
    const source = h.messageStore.append({
      userId: 'user-1',
      catId: 'opus',
      threadId: 'thread-1',
      content,
      mentions: ['codex-sol'],
      deliveryStatus: 'queued',
      timestamp: Date.now() - 10,
    });
    await h.ingest.record(
      buildHandedEvent({
        threadId: 'thread-1',
        fromCatId: 'opus',
        toCatId: 'codex-sol',
        messageId: source.id,
        at: source.timestamp,
      }),
    );
    const entry = queue.enqueue({
      threadId: 'thread-1',
      userId: 'user-1',
      content,
      messageId: source.id,
      source: 'agent',
      targetCats: ['codex-sol'],
      intent: 'execute',
      ownerAuthProvenance: 'strict',
    }).entry;
    h.messageStore.initializeQueueCustody(source.id, createInitialQueuedMessageCustody(entry));
    return source;
  }
  async function get(path) {
    return (await fetch(url + path, { headers })).json();
  }
  async function complete(sourceId) {
    const response = await fetch(url + '/api/callbacks/complete-a2a-dispatch', {
      method: 'POST',
      headers,
      body: JSON.stringify({ disposition: 'handled', ...(sourceId ? { adoptSourceMessageId: sourceId } : {}) }),
    });
    return { status: response.status, body: await response.json() };
  }
  return {
    ...h,
    registry,
    identity,
    executions,
    queue,
    coordinator,
    receipts,
    processor,
    service,
    addSource,
    get,
    complete,
    unregister,
  };
}
