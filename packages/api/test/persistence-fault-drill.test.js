/**
 * Persistence fault-drill tests (#50)
 *
 * Goal:
 * - Simulate persistence outage during message processing.
 * - Verify invocation is marked failed with explicit user-facing signal.
 * - Verify the failed attempt remains terminal when persistence fails.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import Fastify from 'fastify';
import { InvocationQueue } from '../dist/domains/cats/services/agents/invocation/InvocationQueue.js';
import { InvocationRegistry } from '../dist/domains/cats/services/agents/invocation/InvocationRegistry.js';
import { InvocationTracker } from '../dist/domains/cats/services/agents/invocation/InvocationTracker.js';
import { QueuedMessageCustodyCoordinator } from '../dist/domains/cats/services/agents/invocation/QueuedMessageCustodyCoordinator.js';
import { QueueProcessor } from '../dist/domains/cats/services/agents/invocation/QueueProcessor.js';
import { InvocationRecordStore } from '../dist/domains/cats/services/stores/ports/InvocationRecordStore.js';
import { MessageStore } from '../dist/domains/cats/services/stores/ports/MessageStore.js';
import { ThreadStore } from '../dist/domains/cats/services/stores/ports/ThreadStore.js';
import { messagesRoutes } from '../dist/routes/messages.js';

function createMockSocketManager() {
  const events = [];
  return {
    broadcastAgentMessage(msg, threadId) {
      events.push({ type: 'agent', msg, threadId });
    },
    broadcastToRoom(room, event, data) {
      events.push({ type: 'room', room, event, data });
    },
    emitToUser(userId, event, data) {
      events.push({ type: 'user', userId, event, data });
    },
    getEvents() {
      return events;
    },
  };
}

async function waitFor(predicate, timeoutMs = 1500, intervalMs = 20) {
  const startedAt = Date.now();
  while (Date.now() - startedAt <= timeoutMs) {
    if (predicate()) return true;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  return false;
}

function createFaultDrillRouter(modeRef) {
  const ackCalls = [];

  return {
    async resolveTargetsAndIntent() {
      return {
        targetCats: ['opus'],
        intent: { intent: 'execute', explicit: false, promptTags: [] },
      };
    },
    async resolveExplicitTargets(targetCats) {
      return [...targetCats];
    },
    async resolveConversationTargetsAtAdmission(targetCats) {
      return targetCats.length > 0 ? [...targetCats] : ['opus'];
    },
    async *routeExecution(_userId, _content, _threadId, _userMessageId, _targets, _intent, opts = {}) {
      modeRef.invocationId = opts.parentInvocationId;
      if (modeRef.failPersistence) {
        if (opts.persistenceContext) {
          opts.persistenceContext.failed = true;
          opts.persistenceContext.errors.push({
            catId: 'opus',
            error: 'Redis disconnected during append',
          });
        }
      } else if (opts.cursorBoundaries instanceof Map) {
        opts.cursorBoundaries.set('opus', `${Date.now()}:cursor`);
      }

      yield { type: 'text', catId: 'opus', content: 'fault-drill reply', timestamp: Date.now() };
      yield { type: 'done', catId: 'opus', isFinal: true, timestamp: Date.now() };
    },
    async ackCollectedCursors(userId, threadId, boundaries) {
      ackCalls.push({ userId, threadId, boundaries: new Map(boundaries) });
    },
    getAckCalls() {
      return ackCalls;
    },
  };
}

async function setupScenario() {
  const registry = new InvocationRegistry();
  const messageStore = new MessageStore();
  const threadStore = new ThreadStore();
  const invocationRecordStore = new InvocationRecordStore();
  const invocationTracker = new InvocationTracker();
  const invocationQueue = new InvocationQueue();
  const socketManager = createMockSocketManager();
  const modeRef = { failPersistence: true };
  const router = createFaultDrillRouter(modeRef);
  const queueCustodyCoordinator = new QueuedMessageCustodyCoordinator({ messageStore });
  const queueProcessor = new QueueProcessor({
    queue: invocationQueue,
    invocationTracker,
    invocationRecordStore,
    socketManager,
    messageStore,
    router,
    queueCustodyCoordinator,
    log: { info() {}, warn() {}, error() {} },
  });
  const threadId = threadStore.create('user-1', 'fault drill thread').id;

  const app = Fastify();
  await app.register(messagesRoutes, {
    registry,
    messageStore,
    socketManager,
    router,
    threadStore,
    invocationTracker,
    invocationRecordStore,
    invocationQueue,
    queueProcessor,
    queueCustodyCoordinator,
  });
  await app.ready();

  return {
    app,
    modeRef,
    router,
    socketManager,
    invocationRecordStore,
    threadId,
  };
}

describe('Persistence fault drills', () => {
  it('marks invocation failed and emits explicit error when persistence fails mid-flight', async () => {
    const { app, modeRef, threadId, socketManager, invocationRecordStore, router } = await setupScenario();

    const res = await app.inject({
      method: 'POST',
      url: '/api/messages',
      headers: { 'x-cat-cafe-user': 'user-1' },
      payload: {
        content: '@布偶猫 persistence drill',
        threadId,
      },
    });

    assert.equal(res.statusCode, 202);
    const body = res.json();
    assert.equal(body.status, 'queued');
    assert.ok(body.entryId);

    const failedReady = await waitFor(() =>
      Boolean(modeRef.invocationId && invocationRecordStore.get(modeRef.invocationId)?.status === 'failed'),
    );
    assert.equal(failedReady, true, 'invocation should become failed within wait window');

    const record = invocationRecordStore.get(modeRef.invocationId);
    assert.ok(record);
    assert.equal(record.status, 'failed');
    assert.ok(
      String(record.error).includes('Message delivered but persistence failed'),
      'should persist explicit failure reason',
    );

    const failureSignal = socketManager
      .getEvents()
      .find((e) => e.type === 'agent' && e.msg?.type === 'error' && String(e.msg?.error).includes('未能保存'));
    assert.ok(failureSignal, 'should emit explicit user-facing persistence warning');
    assert.equal(router.getAckCalls().length, 0, 'cursor ack must be deferred on failure');

    await app.close();
  });
});
