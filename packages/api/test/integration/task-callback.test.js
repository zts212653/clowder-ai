/**
 * Task Callback Integration Tests
 * 验证 MCP update-task 回传端点与 TaskStore 的集成
 *
 * 使用 Fastify injection + 真实 InvocationRegistry + TaskStore
 */

import assert from 'node:assert/strict';
import { beforeEach, describe, test } from 'node:test';
import Fastify from 'fastify';

const { InvocationRegistry } = await import('../../dist/domains/cats/services/agents/invocation/InvocationRegistry.js');
const { TaskStore } = await import('../../dist/domains/cats/services/stores/ports/TaskStore.js');
const { MessageStore } = await import('../../dist/domains/cats/services/stores/ports/MessageStore.js');
const { callbacksRoutes } = await import('../../dist/routes/callbacks.js');

function createMockSocketManager() {
  const events = [];
  return {
    broadcastAgentMessage(msg) {
      events.push({ type: 'agent', msg });
    },
    broadcastToRoom(room, event, data) {
      events.push({ room, event, data });
    },
    getEvents() {
      return events;
    },
  };
}

describe('Task Callback Integration', () => {
  let registry;
  let messageStore;
  let taskStore;
  let socketManager;

  beforeEach(() => {
    registry = new InvocationRegistry();
    messageStore = new MessageStore();
    taskStore = new TaskStore();
    socketManager = createMockSocketManager();
  });

  async function createApp() {
    const app = Fastify();
    await app.register(callbacksRoutes, {
      registry,
      messageStore,
      socketManager,
      taskStore,
    });
    return app;
  }

  test('MCP update-task succeeds for owned task', async () => {
    const app = await createApp();

    // Create invocation for opus
    const { invocationId, callbackToken } = registry.create('user-1', 'opus', 'thread-1');

    // Create a task owned by opus
    const task = taskStore.create({
      threadId: 'thread-1',
      title: 'Test task',
      why: 'Testing',
      createdBy: 'user',
      ownerCatId: 'opus',
    });

    const response = await app.inject({
      method: 'POST',
      url: '/api/callbacks/update-task',
      payload: {
        invocationId,
        callbackToken,
        taskId: task.id,
        status: 'doing',
      },
    });

    assert.equal(response.statusCode, 200);
    const body = response.json();
    assert.equal(body.status, 'ok');
    assert.equal(body.task.status, 'doing');

    // Verify broadcast
    const events = socketManager.getEvents();
    const taskEvent = events.find((e) => e.event === 'task_updated');
    assert.ok(taskEvent, 'task_updated event should be broadcast');
    assert.equal(taskEvent.room, 'thread:thread-1');
  });

  test('MCP update-task rejects invalid credentials', async () => {
    const app = await createApp();

    const response = await app.inject({
      method: 'POST',
      url: '/api/callbacks/update-task',
      payload: {
        invocationId: 'bad-id',
        callbackToken: 'bad-token',
        taskId: 'some-task',
        status: 'done',
      },
    });

    assert.equal(response.statusCode, 401);
  });

  test('MCP update-task rejects task owned by another cat', async () => {
    const app = await createApp();

    // Invocation for codex
    const { invocationId, callbackToken } = registry.create('user-1', 'codex', 'thread-1');

    // Task owned by opus
    const task = taskStore.create({
      threadId: 'thread-1',
      title: 'Opus task',
      why: 'Testing',
      createdBy: 'user',
      ownerCatId: 'opus',
    });

    const response = await app.inject({
      method: 'POST',
      url: '/api/callbacks/update-task',
      payload: {
        invocationId,
        callbackToken,
        taskId: task.id,
        status: 'done',
      },
    });

    assert.equal(response.statusCode, 403);
  });

  test('MCP update-task allows unowned task', async () => {
    const app = await createApp();

    const { invocationId, callbackToken } = registry.create('user-1', 'opus', 'thread-1');

    // Task with no owner
    const task = taskStore.create({
      threadId: 'thread-1',
      title: 'Unowned task',
      why: 'Anyone can update',
      createdBy: 'user',
    });

    const response = await app.inject({
      method: 'POST',
      url: '/api/callbacks/update-task',
      payload: {
        invocationId,
        callbackToken,
        taskId: task.id,
        status: 'doing',
      },
    });

    assert.equal(response.statusCode, 200);
    assert.equal(response.json().task.status, 'doing');
  });

  test('MCP update-task rejects cross-thread update', async () => {
    const app = await createApp();

    // Invocation in thread-A
    const { invocationId, callbackToken } = registry.create('user-1', 'opus', 'thread-A');

    // Task in thread-B
    const task = taskStore.create({
      threadId: 'thread-B',
      title: 'Task in another thread',
      why: 'Cross-thread test',
      createdBy: 'user',
      ownerCatId: 'opus',
    });

    const response = await app.inject({
      method: 'POST',
      url: '/api/callbacks/update-task',
      payload: {
        invocationId,
        callbackToken,
        taskId: task.id,
        status: 'done',
      },
    });

    assert.equal(response.statusCode, 403);
    assert.match(response.json().error, /different thread/);
  });
});
