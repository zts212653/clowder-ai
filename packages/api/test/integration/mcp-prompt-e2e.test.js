/**
 * MCP Prompt Injection E2E Integration Test
 * 验证: 注入的 skill 引用 + 真实凭证 → 回调端点成功响应
 *
 * 模拟场景: Codex/Gemini 通过 refs/mcp-callbacks.md 获取 curl 模板后，
 * 用 invokeSingleCat 设置的 env vars 构造请求 → 全部 200/正确数据。
 */

import assert from 'node:assert/strict';
import { beforeEach, describe, test } from 'node:test';
import Fastify from 'fastify';

const { InvocationRegistry } = await import('../../dist/domains/cats/services/agents/invocation/InvocationRegistry.js');
const { MessageStore } = await import('../../dist/domains/cats/services/stores/ports/MessageStore.js');
const { TaskStore } = await import('../../dist/domains/cats/services/stores/ports/TaskStore.js');
const { buildMcpCallbackInstructions, needsMcpInjection } = await import(
  '../../dist/domains/cats/services/agents/invocation/McpPromptInjector.js'
);
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

describe('MCP Prompt Injection E2E', () => {
  let registry;
  let messageStore;
  let taskStore;
  let socketManager;
  let app;

  beforeEach(async () => {
    registry = new InvocationRegistry();
    messageStore = new MessageStore();
    taskStore = new TaskStore();
    socketManager = createMockSocketManager();

    app = Fastify();
    await app.register(callbacksRoutes, {
      registry,
      messageStore,
      socketManager,
      taskStore,
    });
  });

  test('injected post-message endpoint succeeds with real credentials', async () => {
    // 1. F041: Verify injection triggers when MCP is unavailable (fallback)
    assert.equal(needsMcpInjection(false), true);

    // 2. Build instructions (same as route-serial does)
    const instructions = buildMcpCallbackInstructions({});

    // 3. Verify the instructions reference the tool name (skill-based, no inline URLs)
    assert.ok(instructions.includes('post-message'));

    // 4. Create real credentials (same as invokeSingleCat does)
    const { invocationId, callbackToken } = registry.create('user-1', 'codex', 'thread-e2e');

    // 5. Simulate what Codex would do: POST to post-message with env var values
    const response = await app.inject({
      method: 'POST',
      url: '/api/callbacks/post-message',
      headers: { 'x-invocation-id': invocationId, 'x-callback-token': callbackToken },
      payload: {
        content: 'Hello from Codex via HTTP callback!',
      },
    });

    assert.equal(response.statusCode, 200, `expected 200, got ${response.statusCode}: ${response.body}`);
    assert.equal(response.json().status, 'ok');

    // 6. Verify message was stored
    const messages = messageStore.getByThread('thread-e2e', 10, 'user-1');
    const codexMsg = messages.find((m) => m.content === 'Hello from Codex via HTTP callback!');
    assert.ok(codexMsg, 'message should be stored in messageStore');
    assert.equal(codexMsg.catId, 'codex');
  });

  test('injected thread-context endpoint succeeds with real credentials', async () => {
    // Pre-populate some messages
    messageStore.append({
      userId: 'user-1',
      catId: null,
      content: '你好',
      mentions: [],
      timestamp: Date.now(),
      threadId: 'thread-e2e',
    });
    messageStore.append({
      userId: 'user-1',
      catId: 'opus',
      content: '你好铲屎官',
      mentions: [],
      timestamp: Date.now() + 1,
      threadId: 'thread-e2e',
    });

    const { invocationId, callbackToken } = registry.create('user-1', 'gemini', 'thread-e2e');

    // Verify instructions reference the tool name (skill-based)
    const instructions = buildMcpCallbackInstructions({});
    assert.ok(instructions.includes('thread-context'));

    // Simulate Gemini calling GET thread-context with query params
    const response = await app.inject({
      method: 'GET',
      url: '/api/callbacks/thread-context',
      headers: { 'x-invocation-id': invocationId, 'x-callback-token': callbackToken },
    });

    assert.equal(response.statusCode, 200, `expected 200, got ${response.statusCode}: ${response.body}`);
    const body = response.json();
    assert.ok(Array.isArray(body.messages));
    assert.ok(body.messages.length >= 2, `expected >= 2 messages, got ${body.messages.length}`);
  });

  test('injected pending-mentions endpoint succeeds with real credentials', async () => {
    const { invocationId, callbackToken } = registry.create('user-1', 'codex', 'thread-e2e');

    const instructions = buildMcpCallbackInstructions({});
    assert.ok(instructions.includes('pending-mentions'));

    const response = await app.inject({
      method: 'GET',
      url: '/api/callbacks/pending-mentions',
      headers: { 'x-invocation-id': invocationId, 'x-callback-token': callbackToken },
    });

    assert.equal(response.statusCode, 200, `expected 200, got ${response.statusCode}: ${response.body}`);
    const body = response.json();
    assert.ok(Array.isArray(body.mentions));
  });

  test('injected update-task endpoint succeeds with real credentials', async () => {
    const { invocationId, callbackToken } = registry.create('user-1', 'gemini', 'thread-e2e');

    // Create a task in the same thread
    const task = taskStore.create({
      threadId: 'thread-e2e',
      title: '设计图标',
      why: '暹罗猫负责视觉',
      createdBy: 'user',
      ownerCatId: 'gemini',
    });

    const instructions = buildMcpCallbackInstructions({});
    assert.ok(instructions.includes('update-task'));

    const response = await app.inject({
      method: 'POST',
      url: '/api/callbacks/update-task',
      headers: { 'x-invocation-id': invocationId, 'x-callback-token': callbackToken },
      payload: {
        taskId: task.id,
        status: 'doing',
        why: '正在绘制中',
      },
    });

    assert.equal(response.statusCode, 200, `expected 200, got ${response.statusCode}: ${response.body}`);
    assert.equal(response.json().task.status, 'doing');
  });

  test('injected endpoints reject invalid credentials (401)', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/callbacks/post-message',
      payload: {
        invocationId: 'fake-id',
        callbackToken: 'fake-token',
        content: 'should fail',
      },
    });

    assert.equal(response.statusCode, 401);
  });
});
