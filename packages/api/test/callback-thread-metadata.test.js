import assert from 'node:assert/strict';
import { beforeEach, describe, test } from 'node:test';
import Fastify from 'fastify';

function createMockSocketManager() {
  return {
    broadcastAgentMessage() {},
    broadcastToRoom() {},
  };
}

function createMockThreadStore() {
  const thread = {
    id: 'thread-meta-1',
    userId: 'user-1',
    createdBy: 'user-1',
    title: 'Thread metadata test',
    labels: [],
    threadMetadata: {},
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
  const atomicMergeCalls = [];

  return {
    atomicMergeCalls,
    get(id) {
      return id === thread.id ? thread : null;
    },
    async atomicMergeThreadMetadata(id, patch) {
      atomicMergeCalls.push({ id, patch });
      thread.threadMetadata = { ...thread.threadMetadata, ...patch };
    },
    async updateTitle(id, title) {
      assert.equal(id, thread.id);
      thread.title = title;
    },
    async updateLabels(id, labels) {
      assert.equal(id, thread.id);
      thread.labels = labels;
    },
  };
}

describe('Callback thread metadata route', () => {
  let registry;
  let threadStore;

  beforeEach(async () => {
    const { InvocationRegistry } = await import(
      '../dist/domains/cats/services/agents/invocation/InvocationRegistry.js'
    );

    registry = new InvocationRegistry();
    threadStore = createMockThreadStore();
  });

  async function createApp() {
    const { callbacksRoutes } = await import('../dist/routes/callbacks.js');
    const app = Fastify();
    await app.register(callbacksRoutes, {
      registry,
      threadStore,
      socketManager: createMockSocketManager(),
    });
    return app;
  }

  async function postSetThreadMetadata(app, payload) {
    const { invocationId, callbackToken } = await registry.create('user-1', 'codex', 'thread-meta-1');
    const res = await app.inject({
      method: 'POST',
      url: '/api/callbacks/set-thread-metadata',
      headers: { 'x-invocation-id': invocationId, 'x-callback-token': callbackToken },
      payload,
    });
    return { statusCode: res.statusCode, body: JSON.parse(res.body) };
  }

  test('rejects empty metadata update payloads', async () => {
    const app = await createApp();

    const res = await postSetThreadMetadata(app, {});

    assert.equal(res.statusCode, 400);
    assert.match(res.body.error, /metadata update/i);
    assert.equal(threadStore.atomicMergeCalls.length, 0);
  });

  test('rejects typo-only payloads that parse to an empty patch', async () => {
    const app = await createApp();

    const res = await postSetThreadMetadata(app, { worktree: '/tmp/not-a-recognized-field' });

    assert.equal(res.statusCode, 400);
    assert.match(res.body.error, /metadata update/i);
    assert.equal(threadStore.atomicMergeCalls.length, 0);
  });

  test('accepts recognized metadata updates', async () => {
    const app = await createApp();

    const res = await postSetThreadMetadata(app, { worktrees: ['/tmp/cat-cafe'] });

    assert.equal(res.statusCode, 200);
    assert.equal(threadStore.atomicMergeCalls.length, 1);
    assert.deepEqual(threadStore.atomicMergeCalls[0], {
      id: 'thread-meta-1',
      patch: { worktrees: ['/tmp/cat-cafe'] },
    });
  });
});
