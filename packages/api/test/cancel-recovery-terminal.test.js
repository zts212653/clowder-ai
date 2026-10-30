import assert from 'node:assert/strict';
import { test } from 'node:test';
import Fastify from 'fastify';
import { InvocationQueue } from '../dist/domains/cats/services/agents/invocation/InvocationQueue.js';
import { queueRoutes } from '../dist/routes/queue.js';

// Regressions adopted from the independent 91d5c02b cancellation review.
for (const complete of [true, false]) {
  test(`REST reconciliation distinguishes confirmed-gone from unknown, complete=${complete}`, async (t) => {
    const broadcasts = [],
      releases = [];
    let ownerReads = 0;
    const app = Fastify({ logger: false });
    t.after(() => app.close());
    await app.register(queueRoutes, {
      threadStore: { get: async (id) => ({ id, title: 'owned', createdBy: 'fixture-owner' }) },
      invocationQueue: new InvocationQueue(),
      invocationTracker: {
        has: () => false,
        getUserId: () => null,
        getExecutionId: () => undefined,
        getSlotState: () => 'absent',
        getCanceledSlotIdentity: () => undefined,
        getActiveSlots: () => [],
      },
      queueProcessor: {
        canReleaseSlotForUser: () => true,
        hasProcessingSlotReservation: () => false,
        releaseSlot: (threadId, catId) => releases.push([threadId, catId]),
        hasActiveExecution: () => false,
        isCatBusy: () => false,
      },
      invocationRecordStore: { get: async () => null, listRunningByThread: async () => [], update: async () => null },
      turnExecutionStore: { listByParent: async () => [] },
      cliExecutionOwnerService: {
        listLive: async () => {
          ownerReads++;
          return { owners: [], complete };
        },
      },
      socketManager: {
        broadcastAgentMessage: (message, threadId) => broadcasts.push({ message, threadId }),
        broadcastToRoom() {},
        emitToUser() {},
      },
      agentSessionMutex: { forceReleaseByScope: () => ({ releasedHolders: 0, rejectedWaiters: 0, catIds: [] }) },
    });
    const response = await app.inject({
      method: 'POST',
      url: '/api/threads/fixture-thread/executions/live/confirmed-gone-parent/cancel',
      headers: { 'x-cat-cafe-user': 'fixture-owner' },
      payload: { catId: 'codex' },
    });
    assert.ok(ownerReads > 0);
    if (!complete) {
      assert.equal(response.statusCode, 503, response.body);
      assert.equal(
        broadcasts.some(({ message }) => message.type === 'done'),
        false,
      );
      assert.deepEqual(releases, []);
      return;
    }
    assert.equal(response.statusCode, 200, response.body);
    assert.deepEqual(response.json(), { ok: true, cancelled: false, reconciled: true });
    assert.deepEqual(releases, [['fixture-thread', 'codex']]);
    assert.equal(broadcasts.length, 1);
    assert.equal(broadcasts[0].threadId, 'fixture-thread');
    assert.equal(broadcasts[0].message.type, 'done');
    assert.equal(broadcasts[0].message.isFinal, true);
    assert.equal(broadcasts[0].message.catId, 'codex');
    assert.equal(broadcasts[0].message.invocationId, 'confirmed-gone-parent');
  });
}
