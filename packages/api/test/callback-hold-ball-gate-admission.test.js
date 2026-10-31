import assert from 'node:assert/strict';
import { test } from 'node:test';
import Fastify from 'fastify';

const { InvocationRegistry } = await import('../dist/domains/cats/services/agents/invocation/InvocationRegistry.js');
const { ThreadStore } = await import('../dist/domains/cats/services/stores/ports/ThreadStore.js');
const { callbacksRoutes } = await import('../dist/routes/callbacks.js');

function deps(registry) {
  return {
    registry,
    holdQuotaStore: {
      async tryAdmit() {
        assert.fail('unsupported full-gate commands must be rejected before quota admission');
      },
      async releaseByEventId() {
        return true;
      },
    },
    taskRunner: { registerDynamic() {}, unregister: () => true },
    templateRegistry: { get: () => ({ createSpec: (taskId, taskParams) => ({ taskId, taskParams }) }) },
    dynamicTaskStore: { insert() {}, getAll: () => [], remove: () => true },
    messageStore: {
      async append(message) {
        return { id: 'message', ...message };
      },
    },
    socketManager: { broadcastToRoom() {} },
    invocationRecordStore: {},
  };
}

test('unsupported full-gate wrappers fail before execution with a recoverable command hint', async (t) => {
  const registry = new InvocationRegistry();
  const threadStore = new ThreadStore();
  const app = Fastify();
  await app.register(callbacksRoutes, {
    registry,
    messageStore: {
      async getMessagesForThread() {
        return [];
      },
    },
    socketManager: { broadcastAgentMessage() {}, getMessages: () => [] },
    threadStore,
    evidenceStore: {
      async store() {},
      async search() {
        return [];
      },
    },
    markerQueue: { enqueue() {} },
    reflectionService: { async run() {} },
    holdBallDeps: deps(registry),
  });
  t.after(() => app.close());
  const thread = await threadStore.create('owner', 'gate admission');
  const { invocationId, callbackToken } = await registry.create('owner', 'codex-sol', thread.id);

  for (const command of [
    'env CI=1 pnpm gate',
    "bash -lc 'pnpm gate'",
    'pnpm gate && echo unsafe',
    'REDIS_URL=redis://127.0.0.1:6399 pnpm gate',
    'env -u PATH pnpm gate',
    'env --unset=REDIS_URL pnpm gate',
    'env --unset REDIS_URL pnpm gate',
    'env REDIS_URL=redis://127.0.0.1:6398 -u NODE_ENV pnpm gate',
    'pnpm\u00a0gate',
    'pnpm\vgate',
    'pnpm\fgate',
  ]) {
    const response = await app.inject({
      method: 'POST',
      url: '/api/callbacks/hold-ball',
      headers: { 'x-invocation-id': invocationId, 'x-callback-token': callbackToken },
      payload: { reason: 'canonical gate', nextStep: 'consume result', wakeWhen: { command } },
    });
    assert.equal(response.statusCode, 400, `${command}: ${response.body}`);
    const body = JSON.parse(response.body);
    assert.equal(body.code, 'durable_gate_recovery_command_unsupported');
    assert.match(body.error, /not eligible for durable recovery/i);
    assert.match(body.action, /pnpm gate/);
  }
});
