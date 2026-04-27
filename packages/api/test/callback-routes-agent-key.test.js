import assert from 'node:assert/strict';
import { beforeEach, describe, test } from 'node:test';
import Fastify from 'fastify';
import './helpers/setup-cat-registry.js';

function createMockSocketManager() {
  const messages = [];
  return {
    broadcastAgentMessage(msg) {
      messages.push(msg);
    },
    getMessages() {
      return messages;
    },
  };
}

describe('Callback routes: agent-key auth path', () => {
  let invocationRegistry;
  let agentKeyRegistry;
  let messageStore;
  let socketManager;
  let threadStore;
  let taskStore;
  let backlogStore;
  let ownedThreadId;

  const TEST_USER = 'user-1';
  const TEST_CAT = 'bengal';

  beforeEach(async () => {
    const { InvocationRegistry } = await import(
      '../dist/domains/cats/services/agents/invocation/InvocationRegistry.js'
    );
    const { AgentKeyRegistry } = await import('../dist/domains/cats/services/agents/agent-key/AgentKeyRegistry.js');
    const { MessageStore } = await import('../dist/domains/cats/services/stores/ports/MessageStore.js');
    const { ThreadStore } = await import('../dist/domains/cats/services/stores/ports/ThreadStore.js');
    const { TaskStore } = await import('../dist/domains/cats/services/stores/ports/TaskStore.js');
    const { BacklogStore } = await import('../dist/domains/cats/services/stores/ports/BacklogStore.js');

    invocationRegistry = new InvocationRegistry();
    agentKeyRegistry = new AgentKeyRegistry({ ttlMs: 86400000 });
    messageStore = new MessageStore();
    threadStore = new ThreadStore();
    taskStore = new TaskStore();
    backlogStore = new BacklogStore();
    socketManager = createMockSocketManager();

    const thread = await threadStore.create(TEST_USER, 'Agent Key Test');
    ownedThreadId = thread.id;
  });

  async function createApp() {
    const { callbacksRoutes } = await import('../dist/routes/callbacks.js');
    const app = Fastify();
    await app.register(callbacksRoutes, {
      registry: invocationRegistry,
      agentKeyRegistry,
      messageStore,
      socketManager,
      threadStore,
      taskStore,
      backlogStore,
    });
    return app;
  }

  async function issueKey() {
    return agentKeyRegistry.issue(TEST_CAT, TEST_USER);
  }

  // ---- POST /api/callbacks/post-message ----

  test('post-message with agent-key requires threadId', async () => {
    const app = await createApp();
    const { secret } = await issueKey();

    const res = await app.inject({
      method: 'POST',
      url: '/api/callbacks/post-message',
      headers: { 'x-agent-key-secret': secret },
      payload: { content: 'hello from bengal' },
    });
    assert.equal(res.statusCode, 400);
    const body = JSON.parse(res.body);
    assert.ok(body.error.includes('threadId'), `error should mention threadId: ${body.error}`);
  });

  test('post-message with agent-key + owned threadId succeeds', async () => {
    const app = await createApp();
    const { secret } = await issueKey();

    const res = await app.inject({
      method: 'POST',
      url: '/api/callbacks/post-message',
      headers: { 'x-agent-key-secret': secret },
      payload: { content: 'hello from bengal', threadId: ownedThreadId },
    });
    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.body);
    assert.equal(body.status, 'ok');
  });

  test('post-message with agent-key + unowned threadId returns 403', async () => {
    const app = await createApp();
    const { secret } = await issueKey();
    const otherThread = await threadStore.create('someone-else', 'Other Thread');

    const res = await app.inject({
      method: 'POST',
      url: '/api/callbacks/post-message',
      headers: { 'x-agent-key-secret': secret },
      payload: { content: 'hello', threadId: otherThread.id },
    });
    assert.equal(res.statusCode, 403);
  });

  // ---- GET /api/callbacks/thread-context ----

  test('thread-context with agent-key requires threadId', async () => {
    const app = await createApp();
    const { secret } = await issueKey();

    const res = await app.inject({
      method: 'GET',
      url: '/api/callbacks/thread-context',
      headers: { 'x-agent-key-secret': secret },
    });
    assert.equal(res.statusCode, 400);
  });

  test('thread-context with agent-key + owned threadId succeeds', async () => {
    const app = await createApp();
    const { secret } = await issueKey();

    const res = await app.inject({
      method: 'GET',
      url: `/api/callbacks/thread-context?threadId=${ownedThreadId}`,
      headers: { 'x-agent-key-secret': secret },
    });
    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.body);
    assert.ok(Array.isArray(body.messages));
  });

  // ---- GET /api/callbacks/list-threads ----

  test('list-threads with agent-key succeeds (no threadId needed)', async () => {
    const app = await createApp();
    const { secret } = await issueKey();

    const res = await app.inject({
      method: 'GET',
      url: '/api/callbacks/list-threads',
      headers: { 'x-agent-key-secret': secret },
    });
    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.body);
    assert.ok(Array.isArray(body.threads));
  });

  // ---- P1-3 pipeline: dedup, mentions, replyTo ----

  test('post-message with agent-key deduplicates by clientMessageId', async () => {
    const app = await createApp();
    const { secret } = await issueKey();

    const payload = { content: 'dedup test', threadId: ownedThreadId, clientMessageId: 'msg-dedup-1' };
    const r1 = await app.inject({
      method: 'POST',
      url: '/api/callbacks/post-message',
      headers: { 'x-agent-key-secret': secret },
      payload,
    });
    assert.equal(JSON.parse(r1.body).status, 'ok');

    const r2 = await app.inject({
      method: 'POST',
      url: '/api/callbacks/post-message',
      headers: { 'x-agent-key-secret': secret },
      payload,
    });
    assert.equal(JSON.parse(r2.body).status, 'duplicate');
  });

  test('post-message with agent-key parses @mentions from content', async () => {
    const app = await createApp();
    const { secret } = await issueKey();

    const res = await app.inject({
      method: 'POST',
      url: '/api/callbacks/post-message',
      headers: { 'x-agent-key-secret': secret },
      payload: { content: '@opus hello from bengal', threadId: ownedThreadId },
    });
    assert.equal(res.statusCode, 200);
    const broadcast = socketManager.getMessages().find((m) => m.type === 'text');
    assert.ok(broadcast, 'should broadcast message');
  });

  test('post-message with agent-key validates replyTo', async () => {
    const app = await createApp();
    const { secret } = await issueKey();

    const r1 = await app.inject({
      method: 'POST',
      url: '/api/callbacks/post-message',
      headers: { 'x-agent-key-secret': secret },
      payload: { content: 'first message', threadId: ownedThreadId },
    });
    const firstMsgId = JSON.parse(r1.body).messageId;

    const r2 = await app.inject({
      method: 'POST',
      url: '/api/callbacks/post-message',
      headers: { 'x-agent-key-secret': secret },
      payload: { content: 'reply to first', threadId: ownedThreadId, replyTo: firstMsgId },
    });
    assert.equal(r2.statusCode, 200);
    const body = JSON.parse(r2.body);
    assert.equal(body.replyTo, firstMsgId);
  });

  // ---- P1 cloud review: broadcast invocationId uniqueness ----

  test('agent-key broadcasts use unique invocationId per message (P1 collision guard)', async () => {
    const app = await createApp();
    const { secret } = await issueKey();

    await app.inject({
      method: 'POST',
      url: '/api/callbacks/post-message',
      headers: { 'x-agent-key-secret': secret },
      payload: { content: 'message one', threadId: ownedThreadId },
    });
    await app.inject({
      method: 'POST',
      url: '/api/callbacks/post-message',
      headers: { 'x-agent-key-secret': secret },
      payload: { content: 'message two', threadId: ownedThreadId },
    });

    const textMessages = socketManager.getMessages().filter((m) => m.type === 'text');
    assert.equal(textMessages.length, 2, 'should have 2 text broadcasts');
    assert.notEqual(
      textMessages[0].invocationId,
      textMessages[1].invocationId,
      'each broadcast must have a unique invocationId to prevent findAssistantDuplicate collision',
    );
  });

  // ---- Invocation path regression ----

  test('post-message with invocation token still works (regression)', async () => {
    const app = await createApp();
    const { invocationId, callbackToken } = await invocationRegistry.create(TEST_USER, TEST_CAT, {
      threadId: ownedThreadId,
    });

    const res = await app.inject({
      method: 'POST',
      url: '/api/callbacks/post-message',
      headers: { 'x-invocation-id': invocationId, 'x-callback-token': callbackToken },
      payload: { content: 'hello via invocation' },
    });
    assert.equal(res.statusCode, 200);
  });
});
