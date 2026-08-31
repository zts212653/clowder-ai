import assert from 'node:assert/strict';
import { test } from 'node:test';
import Fastify from 'fastify';

function makeGuardRejectionLog() {
  return {
    async append() {},
    async queryWindowStrictComplete() {
      return { events: [], truncated: false };
    },
  };
}

test('production route composition registers guard-rejection callbacks exactly once', async () => {
  const { InvocationRegistry } = await import('../dist/domains/cats/services/agents/invocation/InvocationRegistry.js');
  const { ThreadStore } = await import('../dist/domains/cats/services/stores/ports/ThreadStore.js');
  const { callbacksRoutes } = await import('../dist/routes/callbacks.js');
  const { evalHubRoutes } = await import('../dist/routes/eval-hub.js');

  const registry = new InvocationRegistry();
  const threadStore = new ThreadStore();
  const guardRejectionLog = makeGuardRejectionLog();
  const app = Fastify({ logger: false });

  await app.register(evalHubRoutes, {
    harnessFeedbackRoot: '/tmp/cat-cafe-unused-harness-feedback',
    threadStore,
    guardRejectionLog,
  });
  await app.register(callbacksRoutes, {
    registry,
    messageStore: {
      async getMessagesForThread() {
        return [];
      },
    },
    socketManager: {
      broadcastAgentMessage() {},
      getMessages() {
        return [];
      },
    },
    threadStore,
    evidenceStore: {
      async store() {},
      async search() {
        return [];
      },
    },
    markerQueue: { enqueue() {} },
    reflectionService: { async run() {} },
    holdBallDeps: {
      registry,
      taskRunner: { registerDynamic() {}, unregister() {} },
      templateRegistry: { get() {} },
      dynamicTaskStore: { insert() {}, getAll: () => [], remove: () => true },
      messageStore: { async append() {} },
      socketManager: { broadcastToRoom() {} },
      guardRejectionLog,
    },
  });

  await app.ready();
  assert.equal(app.hasRoute({ method: 'POST', url: '/api/callbacks/guard-rejections' }), true);
  assert.equal(app.hasRoute({ method: 'GET', url: '/api/callbacks/guard-rejections' }), true);

  const response = await app.inject({ method: 'POST', url: '/api/callbacks/guard-rejections', payload: {} });
  assert.equal(response.statusCode, 401);
  await app.close();
});
