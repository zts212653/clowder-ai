/**
 * ADR-008 S3: Cursor advancement deferred to invocation succeeded
 *
 * Tests that cursor ack is deferred via cursorBoundaries map (S3 design),
 * and only committed via ackCollectedCursors after the invocation succeeds.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import Fastify from 'fastify';
import { InvocationTracker } from '../dist/domains/cats/services/agents/invocation/InvocationTracker.js';
import { InvocationRecordStore } from '../dist/domains/cats/services/stores/ports/InvocationRecordStore.js';
import { MessageStore } from '../dist/domains/cats/services/stores/ports/MessageStore.js';
import { invocationsRoutes } from '../dist/routes/invocations.js';

function createMockSocketManager() {
  return {
    broadcastAgentMessage() {},
    broadcastToRoom() {},
  };
}

/**
 * Creates a router where ackCollectedCursors tracks calls.
 */
function createTrackingRouter(options = {}) {
  const { shouldThrow } = options;
  const ackCalls = [];
  return {
    routeExecution: async function* (_userId, _msg, _threadId, _userMsgId, _cats, _intent, _opts) {
      if (shouldThrow) throw new Error('Boom');
      yield { type: 'text', catId: 'opus', content: 'ok', timestamp: Date.now() };
      yield { type: 'done', catId: 'opus', timestamp: Date.now() };
    },
    resolveTargetsAndIntent: async () => ({
      targetCats: ['opus'],
      intent: { intent: 'execute', explicit: false, promptTags: [] },
    }),
    async ackCollectedCursors(userId, threadId, boundaries) {
      ackCalls.push({ userId, threadId, boundaries: new Map(boundaries) });
    },
    getAckCalls() {
      return ackCalls;
    },
  };
}

async function setupScenario(router, status = 'failed') {
  const invocationRecordStore = new InvocationRecordStore();
  const messageStore = new MessageStore();
  const invocationTracker = new InvocationTracker();
  const socketManager = createMockSocketManager();

  const storedMsg = messageStore.append({
    userId: 'user-1',
    catId: null,
    content: '@布偶猫 cursor test',
    mentions: ['opus'],
    timestamp: Date.now(),
    threadId: 'thread-c',
  });

  const createResult = invocationRecordStore.create({
    threadId: 'thread-c',
    userId: 'user-1',
    targetCats: ['opus'],
    intent: 'execute',
    idempotencyKey: `key-cursor-${Date.now()}`,
    actionLeaseCarrier: { kind: 'none' },
  });
  // Transition through proper lifecycle: queued → running → target status
  invocationRecordStore.update(createResult.invocationId, {
    userMessageId: storedMsg.id,
    status: 'running',
  });
  invocationRecordStore.update(createResult.invocationId, {
    status,
    ...(status === 'failed' ? { error: 'prev error' } : {}),
  });

  const app = Fastify();
  await app.register(invocationsRoutes, {
    invocationRecordStore,
    messageStore,
    socketManager,
    router,
    invocationTracker,
  });
  await app.ready();

  return { app, invocationRecordStore, invocationId: createResult.invocationId };
}

describe('ADR-008 S3: cursor deferred ack', () => {
  it('ackCollectedCursors is called after successful retry', async () => {
    const router = createTrackingRouter();
    const { app, invocationRecordStore, invocationId } = await setupScenario(router);

    const res = await app.inject({
      method: 'POST',
      url: `/api/invocations/${invocationId}/retry`,
    });
    assert.equal(res.statusCode, 202);

    // Wait for background execution
    await new Promise((r) => setTimeout(r, 150));

    const record = invocationRecordStore.get(invocationId);
    assert.equal(record.status, 'succeeded');

    const ackCalls = router.getAckCalls();
    assert.equal(ackCalls.length, 1, 'ackCollectedCursors should be called exactly once');
    assert.equal(ackCalls[0].userId, 'user-1');
    assert.equal(ackCalls[0].threadId, 'thread-c');
  });

  it('ackCollectedCursors is NOT called when retry execution fails', async () => {
    const router = createTrackingRouter({ shouldThrow: true });
    const { app, invocationRecordStore, invocationId } = await setupScenario(router);

    const res = await app.inject({
      method: 'POST',
      url: `/api/invocations/${invocationId}/retry`,
    });
    assert.equal(res.statusCode, 202);

    // Wait for background execution to fail
    await new Promise((r) => setTimeout(r, 150));

    const record = invocationRecordStore.get(invocationId);
    assert.equal(record.status, 'failed');

    const ackCalls = router.getAckCalls();
    assert.equal(ackCalls.length, 0, 'ackCollectedCursors should NOT be called on failure');
  });

  it('cursorBoundaries map is passed to routeExecution', async () => {
    let capturedOpts;
    const captureRouter = {
      routeExecution: async function* (_u, _m, _t, _mid, _cats, _intent, opts) {
        capturedOpts = opts;
        yield { type: 'text', catId: 'opus', content: 'cap', timestamp: Date.now() };
        yield { type: 'done', catId: 'opus', timestamp: Date.now() };
      },
      resolveTargetsAndIntent: async () => ({
        targetCats: ['opus'],
        intent: { intent: 'execute', explicit: false, promptTags: [] },
      }),
      async ackCollectedCursors() {},
    };

    const { app, invocationId } = await setupScenario(captureRouter);

    await app.inject({
      method: 'POST',
      url: `/api/invocations/${invocationId}/retry`,
    });

    await new Promise((r) => setTimeout(r, 150));

    assert.ok(capturedOpts, 'routeExecution should have been called');
    assert.ok(capturedOpts.cursorBoundaries instanceof Map, 'cursorBoundaries should be a Map instance');
  });
});
