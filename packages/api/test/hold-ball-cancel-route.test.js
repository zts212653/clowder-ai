/**
 * F167 Phase J AC-J1/J3 — DELETE /api/callbacks/hold-ball/:taskId route test.
 *
 * Tests the HTTP endpoint for user-initiated hold ball cancel + confirmation message.
 * Sibling to hold-ball-cancel.test.js (pure function tests).
 */

import assert from 'node:assert/strict';
import { beforeEach, describe, test } from 'node:test';
import Fastify from 'fastify';

describe('F167 Phase J AC-J1: DELETE /api/callbacks/hold-ball/:taskId', () => {
  let registry;
  let threadStore;

  function makeStubDeps(tasks = [], threadOwners = {}) {
    const unregistered = [];
    const removed = [];
    const storedMessages = [];
    const broadcasts = [];
    return {
      registry,
      taskRunner: {
        registerDynamic() {},
        unregister(id) {
          unregistered.push(id);
        },
      },
      templateRegistry: {
        get(id) {
          return id === 'reminder'
            ? {
                createSpec(taskId, taskParams) {
                  return { taskId, taskParams };
                },
              }
            : undefined;
        },
      },
      dynamicTaskStore: {
        insert() {},
        getById(id) {
          return tasks.find((t) => t.id === id && !removed.includes(t.id)) ?? null;
        },
        getAll() {
          return tasks.filter((t) => !removed.includes(t.id));
        },
        remove(id) {
          removed.push(id);
          return true;
        },
      },
      messageStore: {
        async append(msg) {
          const stored = { id: `msg-${storedMessages.length}`, ...msg };
          storedMessages.push(stored);
          return stored;
        },
      },
      socketManager: {
        broadcastToRoom(room, event, data) {
          broadcasts.push({ room, event, data });
        },
      },
      threadStore: {
        get(threadId) {
          const owner = threadOwners[threadId];
          return owner ? { createdBy: owner } : null;
        },
      },
      _unregistered: unregistered,
      _removed: removed,
      _storedMessages: storedMessages,
      _broadcasts: broadcasts,
    };
  }

  function makeHoldTask(id, threadId = 'thread-1', catId = 'codex') {
    return {
      id,
      templateId: 'reminder',
      trigger: { type: 'once', fireAt: Date.now() + 60_000 },
      params: { message: '持球唤醒', targetCatId: catId, triggerUserId: 'user1' },
      display: { label: `持球唤醒 (${catId})`, category: 'system', description: '...' },
      deliveryThreadId: threadId,
      enabled: true,
      createdBy: `hold-ball:${catId}`,
      createdAt: new Date().toISOString(),
    };
  }

  beforeEach(async () => {
    const { InvocationRegistry } = await import(
      '../dist/domains/cats/services/agents/invocation/InvocationRegistry.js'
    );
    const { ThreadStore } = await import('../dist/domains/cats/services/stores/ports/ThreadStore.js');
    registry = new InvocationRegistry();
    threadStore = new ThreadStore();
  });

  async function createApp(holdBallDeps) {
    const { callbacksRoutes } = await import('../dist/routes/callbacks.js');
    const app = Fastify();
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
      holdBallDeps,
    });
    return app;
  }

  test('200 on valid cancel — removes task + emits confirmation message', async () => {
    const task = makeHoldTask('hold-ball-123-abc', 'thread-del1');
    const deps = makeStubDeps([task], { 'thread-del1': 'test-user' });
    const app = await createApp(deps);

    const res = await app.inject({
      method: 'DELETE',
      url: '/api/callbacks/hold-ball/hold-ball-123-abc',
      headers: { 'x-cat-cafe-user': 'test-user' },
    });

    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.body);
    assert.equal(body.status, 'ok');
    assert.equal(body.cancelled, true);
    assert.equal(body.taskId, 'hold-ball-123-abc');

    assert.deepEqual(deps._unregistered, ['hold-ball-123-abc']);
    assert.deepEqual(deps._removed, ['hold-ball-123-abc']);

    assert.equal(deps._storedMessages.length, 1, 'AC-J3: should emit cancel confirmation');
    assert.match(deps._storedMessages[0].content, /持球已取消/);
    assert.equal(deps._storedMessages[0].threadId, 'thread-del1');

    assert.equal(deps._broadcasts.length, 1, 'should broadcast connector_message');
    assert.equal(deps._broadcasts[0].room, 'thread:thread-del1');
    assert.equal(deps._broadcasts[0].event, 'connector_message');
  });

  test('404 on non-existent taskId', async () => {
    const deps = makeStubDeps([]);
    const app = await createApp(deps);

    const res = await app.inject({
      method: 'DELETE',
      url: '/api/callbacks/hold-ball/hold-ball-999-nope',
      headers: { 'x-cat-cafe-user': 'test-user' },
    });

    assert.equal(res.statusCode, 404);
    assert.equal(deps._unregistered.length, 0);
    assert.equal(deps._removed.length, 0);
    assert.equal(deps._storedMessages.length, 0, 'no confirmation on 404');
  });

  test('401 on DELETE without any user identity (no Origin, no session, no header)', async () => {
    const task = makeHoldTask('hold-ball-noauth', 'thread-noauth');
    const deps = makeStubDeps([task], { 'thread-noauth': 'real-owner' });
    const app = await createApp(deps);

    const res = await app.inject({
      method: 'DELETE',
      url: '/api/callbacks/hold-ball/hold-ball-noauth',
    });

    assert.equal(res.statusCode, 401, 'bare request without identity must be rejected');
    assert.equal(deps._unregistered.length, 0);
    assert.equal(deps._removed.length, 0);
  });

  test('401 on DELETE with untrusted origin', async () => {
    const task = makeHoldTask('hold-ball-evil', 'thread-evil');
    const deps = makeStubDeps([task], { 'thread-evil': 'real-owner' });
    const app = await createApp(deps);

    const res = await app.inject({
      method: 'DELETE',
      url: '/api/callbacks/hold-ball/hold-ball-evil',
      headers: { origin: 'https://evil.example.com' },
    });

    assert.equal(res.statusCode, 401, 'untrusted origin should be rejected');
    assert.equal(deps._unregistered.length, 0);
    assert.equal(deps._removed.length, 0);
  });

  test('200 on system/default thread — any authenticated user can cancel', async () => {
    const task = makeHoldTask('hold-ball-sys-ok', 'default', 'codex');
    const deps = makeStubDeps([task], { default: 'system' });
    const app = await createApp(deps);

    const res = await app.inject({
      method: 'DELETE',
      url: '/api/callbacks/hold-ball/hold-ball-sys-ok',
      headers: { 'x-cat-cafe-user': 'any-user' },
    });

    assert.equal(res.statusCode, 200, 'system thread should be accessible to any authenticated user');
    assert.deepEqual(deps._unregistered, ['hold-ball-sys-ok']);
    assert.deepEqual(deps._removed, ['hold-ball-sys-ok']);
  });

  test('403 on DELETE by non-owner of the thread', async () => {
    const task = makeHoldTask('hold-ball-stolen', 'thread-owned', 'codex');
    const deps = makeStubDeps([task], { 'thread-owned': 'real-owner' });
    const app = await createApp(deps);

    const res = await app.inject({
      method: 'DELETE',
      url: '/api/callbacks/hold-ball/hold-ball-stolen',
      headers: { 'x-cat-cafe-user': 'attacker' },
    });

    assert.equal(res.statusCode, 403, 'non-owner must not cancel holds in another thread');
    assert.equal(deps._unregistered.length, 0, 'must not unregister');
    assert.equal(deps._removed.length, 0, 'must not remove');
    assert.equal(deps._storedMessages.length, 0, 'no confirmation on 403');
  });

  test('404 on non-hold-ball task (dyn-* prefix)', async () => {
    const panelTask = makeHoldTask('dyn-panel-123', 'thread-del2');
    const deps = makeStubDeps([panelTask], { 'thread-del2': 'test-user' });
    const app = await createApp(deps);

    const res = await app.inject({
      method: 'DELETE',
      url: '/api/callbacks/hold-ball/dyn-panel-123',
      headers: { 'x-cat-cafe-user': 'test-user' },
    });

    assert.equal(res.statusCode, 404);
    assert.equal(deps._unregistered.length, 0, 'must not touch non-hold task');
  });
});
