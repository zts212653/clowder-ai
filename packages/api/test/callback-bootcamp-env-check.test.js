/**
 * Callback Bootcamp Env Check Tests
 * POST /api/callbacks/bootcamp-env-check
 */

import assert from 'node:assert/strict';
import { beforeEach, describe, test } from 'node:test';
import Fastify from 'fastify';
import './helpers/setup-cat-registry.js';

describe('Callback Bootcamp Env Check', () => {
  let registry;
  let threadStore;
  let messageStore;
  let socketManager;

  beforeEach(async () => {
    const { InvocationRegistry } = await import(
      '../dist/domains/cats/services/agents/invocation/InvocationRegistry.js'
    );
    const { ThreadStore } = await import('../dist/domains/cats/services/stores/ports/ThreadStore.js');
    const { MessageStore } = await import('../dist/domains/cats/services/stores/ports/MessageStore.js');

    registry = new InvocationRegistry();
    threadStore = new ThreadStore();
    messageStore = new MessageStore();
    socketManager = {
      broadcastAgentMessage() {},
      getMessages() {
        return [];
      },
    };
  });

  async function createApp() {
    const { callbacksRoutes } = await import('../dist/routes/callbacks.js');
    const app = Fastify();
    await app.register(callbacksRoutes, {
      registry,
      messageStore,
      socketManager,
      threadStore,
      sharedBank: 'cat-cafe-shared',
    });
    return app;
  }

  test('returns 401 without valid credentials', async () => {
    const app = await createApp();

    const response = await app.inject({
      method: 'POST',
      url: '/api/callbacks/bootcamp-env-check',
      payload: {
        invocationId: 'fake-id',
        callbackToken: 'fake-token',
        threadId: 'thread-1',
      },
    });

    assert.equal(response.statusCode, 401);
  });

  test('returns env check results with expected shape', async () => {
    const app = await createApp();

    const thread = await threadStore.create('user-1', '🎓 训练营');
    const { invocationId, callbackToken } = registry.create('user-1', 'opus', thread.id);

    const response = await app.inject({
      method: 'POST',
      url: '/api/callbacks/bootcamp-env-check',
      headers: { 'x-invocation-id': invocationId, 'x-callback-token': callbackToken },
      payload: {
        threadId: thread.id,
      },
    });

    assert.equal(response.statusCode, 200);
    const body = JSON.parse(response.body);
    // Should have all expected fields
    assert.ok('node' in body);
    assert.ok('pnpm' in body);
    assert.ok('git' in body);
    assert.ok('claudeCli' in body);
    assert.ok('codexCli' in body);
    assert.ok('geminiCli' in body);
    assert.ok('kimiCli' in body);
    assert.ok('mcp' in body);
    assert.ok('tts' in body);
    assert.ok('asr' in body);
    assert.ok('pencil' in body);
    // Each core item has ok field
    assert.equal(typeof body.node.ok, 'boolean');
    assert.equal(typeof body.tts.ok, 'boolean');
  });

  test('auto-stores envCheck in bootcampState when state exists', async () => {
    const app = await createApp();

    const thread = await threadStore.create('user-1', '🎓 训练营');
    const { invocationId, callbackToken } = registry.create('user-1', 'opus', thread.id);
    await threadStore.updateBootcampState(thread.id, {
      v: 1,
      phase: 'phase-2-env-check',
      leadCat: 'opus',
      startedAt: 1000,
    });

    const response = await app.inject({
      method: 'POST',
      url: '/api/callbacks/bootcamp-env-check',
      headers: { 'x-invocation-id': invocationId, 'x-callback-token': callbackToken },
      payload: {
        threadId: thread.id,
      },
    });

    assert.equal(response.statusCode, 200);

    // Verify envCheck was stored in bootcampState
    const updated = await threadStore.get(thread.id);
    assert.ok(updated.bootcampState.envCheck);
    assert.ok('node' in updated.bootcampState.envCheck);
    // Original state preserved
    assert.equal(updated.bootcampState.phase, 'phase-2-env-check');
    assert.equal(updated.bootcampState.leadCat, 'opus');
  });

  test('P1: rejects default-thread invocation checking another thread', async () => {
    const app = await createApp();
    const threadB = await threadStore.create('user-1', 'Thread B');
    await threadStore.updateBootcampState(threadB.id, {
      v: 1,
      phase: 'phase-2-env-check',
      startedAt: 1000,
    });

    // Invocation with default thread (no threadId passed)
    const { invocationId, callbackToken } = registry.create('user-1', 'opus');

    const response = await app.inject({
      method: 'POST',
      url: '/api/callbacks/bootcamp-env-check',
      headers: { 'x-invocation-id': invocationId, 'x-callback-token': callbackToken },
      payload: {
        threadId: threadB.id,
      },
    });

    assert.equal(response.statusCode, 403);
    const after = await threadStore.get(threadB.id);
    assert.equal(after.bootcampState.envCheck, undefined);
  });

  test('P1: rejects cross-thread env-check (invocation bound to thread A, checking thread B)', async () => {
    const app = await createApp();
    const threadA = await threadStore.create('user-1', 'Thread A');
    const threadB = await threadStore.create('user-1', 'Thread B');
    await threadStore.updateBootcampState(threadB.id, {
      v: 1,
      phase: 'phase-2-env-check',
      startedAt: 1000,
    });

    // Invocation is bound to thread A
    const { invocationId, callbackToken } = registry.create('user-1', 'opus', threadA.id);

    // Try to env-check thread B — should be rejected
    const response = await app.inject({
      method: 'POST',
      url: '/api/callbacks/bootcamp-env-check',
      headers: { 'x-invocation-id': invocationId, 'x-callback-token': callbackToken },
      payload: {
        threadId: threadB.id,
      },
    });

    assert.equal(response.statusCode, 403);

    // Verify thread B bootcampState was NOT modified (no envCheck added)
    const threadBAfter = await threadStore.get(threadB.id);
    assert.equal(threadBAfter.bootcampState.envCheck, undefined);
  });

  test('returns 404 for non-existent thread', async () => {
    const app = await createApp();
    const { invocationId, callbackToken } = registry.create('user-1', 'opus', 'nonexistent');

    const response = await app.inject({
      method: 'POST',
      url: '/api/callbacks/bootcamp-env-check',
      headers: { 'x-invocation-id': invocationId, 'x-callback-token': callbackToken },
      payload: {
        threadId: 'nonexistent',
      },
    });

    assert.equal(response.statusCode, 404);
  });
});
