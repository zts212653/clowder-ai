import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { test } from 'node:test';
import Fastify from 'fastify';

test('F257 production composition registers guard-rejection callbacks exactly once', async (t) => {
  const [{ evalHubRoutes }, { callbacksRoutes }, { InvocationRegistry }, { ThreadStore }] = await Promise.all([
    import('../dist/routes/eval-hub.js'),
    import('../dist/routes/callbacks.js'),
    import('../dist/domains/cats/services/agents/invocation/InvocationRegistry.js'),
    import('../dist/domains/cats/services/stores/ports/ThreadStore.js'),
  ]);

  const app = Fastify({ logger: false });
  t.after(() => app.close());

  const registry = new InvocationRegistry();
  const threadStore = new ThreadStore();
  const guardRejectionLog = {
    async append() {},
    async queryWindowComplete() {
      return { events: [], truncated: false };
    },
  };

  app.register(evalHubRoutes, {
    harnessFeedbackRoot: resolve(process.cwd(), 'docs', 'harness-feedback'),
    threadStore,
    guardRejectionLog,
  });
  app.register(callbacksRoutes, {
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

  await assert.doesNotReject(app.ready());
  assert.equal(app.hasRoute({ method: 'POST', url: '/api/callbacks/guard-rejections' }), true);
  assert.equal(app.hasRoute({ method: 'GET', url: '/api/callbacks/guard-rejections' }), true);
});
