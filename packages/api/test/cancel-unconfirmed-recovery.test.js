import assert from 'node:assert/strict';
import { test } from 'node:test';
import Fastify from 'fastify';
import { InvocationQueue } from '../dist/domains/cats/services/agents/invocation/InvocationQueue.js';
import { InMemoryTurnExecutionStore } from '../dist/domains/cats/services/stores/memory/InMemoryTurnExecutionStore.js';
import { queueRoutes } from '../dist/routes/queue.js';

for (const mode of ['incomplete', 'empty', 'controlled', 'write-failure', 'ack-only'])
  test(`REST stop keeps exact provider ownership until proof commits: ${mode}`, async (t) => {
    const scope = {
      invocationId: 'proof-child',
      parentInvocationId: 'proof-parent',
      threadId: 'proof-thread',
      userId: 'proof-user',
      catId: 'codex',
      executionKind: 'ordinary',
      startedAt: 0,
      providerLifecycleTracked: true,
    };
    const turns = new InMemoryTurnExecutionStore();
    turns.createRunning(scope);
    turns.markProviderStarted(scope.invocationId, 0);
    if (mode === 'write-failure')
      turns.transitionTerminal = () => {
        throw new Error('ledger unavailable');
      };
    const parent = {
      id: scope.parentInvocationId,
      threadId: scope.threadId,
      userId: scope.userId,
      targetCats: [scope.catId],
      status: 'running',
      createdAt: 0,
      updatedAt: 0,
    };
    const messages = [],
      releases = [],
      controls = [];
    const app = Fastify({ logger: false });
    t.after(() => app.close());
    await app.register(queueRoutes, {
      threadStore: { get: async (id) => ({ id, title: 'owned', createdBy: scope.userId }) },
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
        releaseSlot: () => releases.push('slot'),
        hasActiveExecution: () => false,
        isCatBusy: () => false,
      },
      invocationRecordStore: {
        get: async (id) => (id === parent.id ? parent : null),
        listRunningByThread: async () => (parent.status === 'running' ? [parent] : []),
        update: async (_id, patch) => Object.assign(parent, patch),
      },
      turnExecutionStore: turns,
      cliExecutionOwnerService: {
        listLive: async () => ({
          complete: mode !== 'incomplete',
          owners: ['controlled', 'write-failure', 'ack-only'].includes(mode)
            ? [
                {
                  executionId: parent.id,
                  invocationId: scope.invocationId,
                  threadId: scope.threadId,
                  userId: scope.userId,
                  catId: scope.catId,
                  startedAt: 0,
                },
              ]
            : [],
        }),
        terminateExact: async (owner) => {
          controls.push(owner);
          return { matched: 1, signaled: 1, complete: true, ...(mode !== 'ack-only' ? { stopped: true } : {}) };
        },
      },
      socketManager: {
        broadcastAgentMessage: (message) => messages.push(message),
        broadcastToRoom() {},
        emitToUser() {},
      },
      agentSessionMutex: {
        forceReleaseByScope: () => {
          releases.push('lock');
          return { releasedHolders: 0, rejectedWaiters: 0, catIds: [] };
        },
      },
    });
    const response = await app.inject({
      method: 'POST',
      url: `/api/threads/${scope.threadId}/executions/live/${parent.id}/cancel`,
      headers: { 'x-cat-cafe-user': scope.userId },
      payload: { catId: scope.catId },
    });
    if (mode === 'controlled') {
      assert.equal(response.statusCode, 200, response.body);
      assert.equal(controls.length, 1);
      assert.equal(turns.get(scope.invocationId).status, 'canceled');
      assert.ok(turns.get(scope.invocationId).providerTeardownAt >= 0);
      assert.equal(messages.filter((m) => m.type === 'done').length, 1);
    } else {
      assert.equal(response.statusCode, 503, response.body);
      assert.equal(turns.get(scope.invocationId).status, 'running');
      assert.equal(turns.get(scope.invocationId).providerTeardownAt, undefined);
      assert.equal(parent.status, 'running');
      assert.deepEqual(releases, []);
      assert.equal(
        messages.some((m) => m.type === 'done'),
        false,
      );
    }
  });
