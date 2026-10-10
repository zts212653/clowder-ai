import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { beforeEach, describe, test } from 'node:test';
import Fastify from 'fastify';
import './helpers/setup-cat-registry.js';
import { canonicalTestMessageInput } from './helpers/message-from-fixtures.js';

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
    process.env.DEFAULT_OWNER_USER_ID = TEST_USER;
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

  async function issueGptProKey(userId = TEST_USER) {
    return agentKeyRegistry.issue('gpt-pro', userId);
  }

  // ---- GET /api/callbacks/auth-probe ----

  test('auth-probe verifies an agent-key principal without reading thread data', async () => {
    const app = await createApp();
    const { secret } = await issueGptProKey();

    const res = await app.inject({
      method: 'GET',
      url: '/api/callbacks/auth-probe',
      headers: { 'x-agent-key-secret': secret },
    });

    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.json(), { ok: true });
  });

  test('auth-probe rejects a valid agent key for another cat', async () => {
    const app = await createApp();
    const { secret } = await issueKey();

    const res = await app.inject({
      method: 'GET',
      url: '/api/callbacks/auth-probe',
      headers: { 'x-agent-key-secret': secret },
    });

    assert.equal(res.statusCode, 403);
    assert.deepEqual(res.json(), { ok: false, reason: 'gpt_pro_principal_required' });
  });

  test('auth-probe rejects a gpt-pro key for another user', async () => {
    const app = await createApp();
    const { secret } = await issueGptProKey('other-user');

    const res = await app.inject({
      method: 'GET',
      url: '/api/callbacks/auth-probe',
      headers: { 'x-agent-key-secret': secret },
    });

    assert.equal(res.statusCode, 403);
    assert.deepEqual(res.json(), { ok: false, reason: 'gpt_pro_principal_required' });
  });

  test('auth-probe rejects an unknown sidecar secret', async () => {
    const app = await createApp();
    const res = await app.inject({
      method: 'GET',
      url: '/api/callbacks/auth-probe',
      headers: { 'x-agent-key-secret': 'stale-sidecar-secret' },
    });

    assert.equal(res.statusCode, 401);
    assert.equal(res.json().reason, 'agent_key_unknown');
  });

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

  test('post-message with agent-key rejects unsupported coordination instead of silently dropping it', async () => {
    const app = await createApp();
    const { secret } = await issueKey();

    const res = await app.inject({
      method: 'POST',
      url: '/api/callbacks/post-message',
      headers: { 'x-agent-key-secret': secret },
      payload: {
        content: 'agent-key cannot establish relay provenance',
        threadId: ownedThreadId,
        coordination: { phase: 'active' },
      },
    });

    assert.equal(res.statusCode, 400);
    assert.equal(res.json().kind, 'coordination_agent_key_unsupported');
    assert.equal(messageStore.getByThread(ownedThreadId, 10, TEST_USER).length, 0);
  });

  test('post-message with agent-key rejects soft-deleted owned thread without storing or broadcasting', async () => {
    const deletedThread = await threadStore.create(TEST_USER, 'Deleted Agent-Key Target');
    assert.equal(await threadStore.softDelete(deletedThread.id), true);
    const app = await createApp();
    const { secret } = await issueKey();

    const res = await app.inject({
      method: 'POST',
      url: '/api/callbacks/post-message',
      headers: { 'x-agent-key-secret': secret },
      payload: { content: 'should not land in deleted thread', threadId: deletedThread.id },
    });

    assert.equal(res.statusCode, 410);
    const body = JSON.parse(res.body);
    assert.equal(body.code, 'THREAD_DELETED');
    assert.equal(messageStore.getByThread(deletedThread.id, 10, TEST_USER).length, 0);
    assert.equal(socketManager.getMessages().length, 0);
  });

  test('post-message with agent-key synthesizes text-only audio rich blocks before storing', async () => {
    const { initVoiceBlockSynthesizer } = await import('../dist/domains/cats/services/tts/VoiceBlockSynthesizer.js');
    const cacheDir = mkdtempSync(path.join(os.tmpdir(), 'cat-cafe-agent-key-audio-'));
    initVoiceBlockSynthesizer(
      {
        getDefault: () => ({
          id: 'mock',
          model: 'test',
          synthesize: async () => ({
            audio: Buffer.from('fake-audio-data'),
            format: 'wav',
            metadata: { provider: 'mock', model: 'test', voice: 'test' },
          }),
        }),
      },
      cacheDir,
    );

    const app = await createApp();
    const { secret } = await issueKey();
    const richPayload = JSON.stringify({
      v: 1,
      blocks: [{ id: 'voice-agent-key', kind: 'audio', v: 1, text: 'agent-key voice message' }],
    });

    const res = await app.inject({
      method: 'POST',
      url: '/api/callbacks/post-message',
      headers: { 'x-agent-key-secret': secret },
      payload: {
        content: `\`\`\`cc_rich\n${richPayload}\n\`\`\``,
        threadId: ownedThreadId,
      },
    });

    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.body);
    assert.equal(body.status, 'ok');

    const messages = await messageStore.getByThread(ownedThreadId);
    const block = messages[0].extra.rich.blocks[0];
    assert.equal(block.kind, 'audio');
    assert.equal(block.text, 'agent-key voice message');
    assert.match(block.url, /^\/api\/tts\/audio\/.+\.wav$/);
    assert.equal(block.mimeType, 'audio/wav');
  });

  test('post-message with agent-key does not deduplicate distinct rich-block-only payloads', async () => {
    const app = await createApp();
    const { secret } = await issueKey();
    const headers = { 'x-agent-key-secret': secret };
    const richContent = (id, title) => {
      const richPayload = JSON.stringify({
        v: 1,
        blocks: [{ id, kind: 'card', v: 1, title }],
      });
      return `\`\`\`cc_rich\n${richPayload}\n\`\`\``;
    };

    const first = await app.inject({
      method: 'POST',
      url: '/api/callbacks/post-message',
      headers,
      payload: {
        content: richContent('first-card', 'First card'),
        threadId: ownedThreadId,
      },
    });
    const second = await app.inject({
      method: 'POST',
      url: '/api/callbacks/post-message',
      headers,
      payload: {
        content: richContent('second-card', 'Second card'),
        threadId: ownedThreadId,
      },
    });

    assert.equal(first.statusCode, 200);
    assert.equal(second.statusCode, 200);
    assert.equal(JSON.parse(first.body).status, 'ok');
    assert.equal(JSON.parse(second.body).status, 'ok');

    const messages = await messageStore.getByThread(ownedThreadId);
    assert.equal(messages.length, 2, 'different rich-block-only payloads must persist as separate messages');
    assert.deepEqual(
      messages.map((msg) => msg.extra.rich.blocks[0].id),
      ['first-card', 'second-card'],
    );
  });

  test('post-message with agent-key does not deduplicate plain text after same-text rich payload', async () => {
    const app = await createApp();
    const { secret } = await issueKey();
    const headers = { 'x-agent-key-secret': secret };
    const richPayload = JSON.stringify({
      v: 1,
      blocks: [{ id: 'hello-card', kind: 'card', v: 1, title: 'hello' }],
    });

    const rich = await app.inject({
      method: 'POST',
      url: '/api/callbacks/post-message',
      headers,
      payload: {
        content: `hello\n\n\`\`\`cc_rich\n${richPayload}\n\`\`\``,
        threadId: ownedThreadId,
      },
    });
    const plain = await app.inject({
      method: 'POST',
      url: '/api/callbacks/post-message',
      headers,
      payload: {
        content: 'hello',
        threadId: ownedThreadId,
      },
    });

    assert.equal(rich.statusCode, 200);
    assert.equal(plain.statusCode, 200);
    assert.equal(JSON.parse(rich.body).status, 'ok');
    assert.equal(JSON.parse(plain.body).status, 'ok');

    const messages = await messageStore.getByThread(ownedThreadId);
    assert.equal(messages.length, 2, 'plain text must not be swallowed by a same-text rich callback');
    assert.equal(messages[0].content, 'hello');
    assert.equal(messages[0].extra.rich.blocks[0].id, 'hello-card');
    assert.equal(messages[1].content, 'hello');
    assert.equal(messages[1].extra?.rich, undefined);
  });

  test('agent-key callback concurrent same-ID retries share one durable message', async () => {
    const app = await createApp();
    const { secret } = await issueKey();
    const headers = { 'x-agent-key-secret': secret };
    const realAppendIdempotent = messageStore.appendIdempotent.bind(messageStore);
    let releaseFirst;
    const gate = new Promise((resolve) => {
      releaseFirst = resolve;
    });
    let enteredFirst;
    const entered = new Promise((resolve) => {
      enteredFirst = resolve;
    });
    let calls = 0;
    messageStore.appendIdempotent = async (input) => {
      if (++calls === 1) {
        enteredFirst();
        await gate;
      }
      return realAppendIdempotent(input);
    };
    const payload = {
      content: 'concurrent identical callback',
      clientMessageId: 'concurrent-source-a',
      threadId: ownedThreadId,
    };
    const firstPromise = app.inject({ method: 'POST', url: '/api/callbacks/post-message', headers, payload });
    await entered;
    let second;
    try {
      second = await app.inject({
        method: 'POST',
        url: '/api/callbacks/post-message',
        headers,
        payload: { ...payload, clientMessageId: 'concurrent-source-a' },
      });
    } finally {
      releaseFirst();
    }
    const first = await firstPromise;
    assert.equal(first.statusCode, 200);
    assert.equal(second.statusCode, 200);
    assert.equal(first.json().status, 'duplicate');
    assert.equal(second.json().status, 'ok');
    assert.equal(first.json().messageId, second.json().messageId);
    assert.equal(messageStore.size, 1);
    assert.equal(socketManager.getMessages().filter((m) => m.type === 'text').length, 1);
  });

  test('agent-key callback concurrent different IDs preserve identical text', async () => {
    const app = await createApp();
    const { secret } = await issueKey();
    const headers = { 'x-agent-key-secret': secret };
    const realAppendIdempotent = messageStore.appendIdempotent.bind(messageStore);
    let releaseFirst;
    const gate = new Promise((resolve) => {
      releaseFirst = resolve;
    });
    let enteredFirst;
    const entered = new Promise((resolve) => {
      enteredFirst = resolve;
    });
    let calls = 0;
    messageStore.appendIdempotent = async (input) => {
      if (++calls === 1) {
        enteredFirst();
        await gate;
      }
      return realAppendIdempotent(input);
    };
    const payload = {
      content: 'concurrent identical callback',
      clientMessageId: 'concurrent-source-a',
      threadId: ownedThreadId,
    };
    const firstPromise = app.inject({ method: 'POST', url: '/api/callbacks/post-message', headers, payload });
    await entered;
    let second;
    try {
      second = await app.inject({
        method: 'POST',
        url: '/api/callbacks/post-message',
        headers,
        payload: { ...payload, clientMessageId: 'concurrent-source-b' },
      });
    } finally {
      releaseFirst();
    }
    const first = await firstPromise;
    assert.equal(first.statusCode, 200);
    assert.equal(second.statusCode, 200);
    assert.equal(first.json().status, 'ok');
    assert.equal(second.json().status, 'ok');
    assert.notEqual(first.json().messageId, second.json().messageId);
    assert.equal(messageStore.size, 2);
    assert.equal(socketManager.getMessages().filter((m) => m.type === 'text').length, 2);
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

  test('thread-context with agent-key can read owned soft-deleted thread tombstones', async () => {
    const deletedThread = await threadStore.create(TEST_USER, 'Deleted Readable Thread');
    messageStore.append(
      canonicalTestMessageInput({
        userId: TEST_USER,
        catId: TEST_CAT,
        content: 'context survives deletion',
        mentions: [],
        origin: 'callback',
        timestamp: Date.now(),
        threadId: deletedThread.id,
      }),
    );
    assert.equal(await threadStore.softDelete(deletedThread.id), true);
    const app = await createApp();
    const { secret } = await issueKey();

    const res = await app.inject({
      method: 'GET',
      url: `/api/callbacks/thread-context?threadId=${deletedThread.id}`,
      headers: { 'x-agent-key-secret': secret },
    });

    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.body);
    assert.equal(body.threadId, deletedThread.id);
    assert.equal(body.messages.length, 1);
    assert.equal(body.messages[0].preview, 'context survives deletion');
    assert.equal('content' in body.messages[0], false);
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

  test('agent-key callback preserves different explicit message IDs with identical content', async () => {
    const app = await createApp();
    const { secret } = await issueKey();
    const headers = { 'x-agent-key-secret': secret };
    const base = { content: 'independent same-text callback', threadId: ownedThreadId };
    const post = (clientMessageId) =>
      app.inject({
        method: 'POST',
        url: '/api/callbacks/post-message',
        headers,
        payload: { ...base, clientMessageId },
      });
    const first = await post('distinct-source-a');
    const retry = await post('distinct-source-a');
    const second = await post('distinct-source-b');
    assert.equal(first.json().status, 'ok');
    assert.equal(retry.json().status, 'duplicate');
    assert.equal(second.json().status, 'ok', 'A different client ID is a new source, not a body duplicate');
    assert.notEqual(first.json().messageId, second.json().messageId);
    assert.equal((await messageStore.getByThread(ownedThreadId)).length, 2);
  });

  test('agent-key callback retry restores an append that failed before persistence', async () => {
    const app = await createApp();
    const { secret } = await issueKey();
    const headers = { 'x-agent-key-secret': secret };
    const base = { content: 'independent same-text callback', threadId: ownedThreadId };
    const originalAppend = messageStore.append.bind(messageStore);
    let attempts = 0;
    messageStore.append = (input) => {
      if (++attempts === 1) throw new Error('isolated store failure before persistence');
      return originalAppend(input);
    };
    const payload = { ...base, clientMessageId: 'retry-after-store-failure' };
    const first = await app.inject({ method: 'POST', url: '/api/callbacks/post-message', headers, payload });
    assert.equal(first.statusCode, 500);
    assert.equal((await messageStore.getByThread(ownedThreadId)).length, 0);
    const retry = await app.inject({ method: 'POST', url: '/api/callbacks/post-message', headers, payload });
    assert.equal(retry.json().status, 'ok', 'Failed persistence must not consume the source identity');
    const replay = await app.inject({ method: 'POST', url: '/api/callbacks/post-message', headers, payload });
    assert.equal(replay.json().status, 'duplicate');
    assert.equal(replay.json().messageId, retry.json().messageId);
    assert.equal((await messageStore.getByThread(ownedThreadId)).length, 1);
  });

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

  test('agent-key callback without a client ID preserves repeated text as independent messages', async () => {
    const app = await createApp();
    const { secret } = await issueKey();

    const payload = { content: 'same smoke report', threadId: ownedThreadId };
    const r1 = await app.inject({
      method: 'POST',
      url: '/api/callbacks/post-message',
      headers: { 'x-agent-key-secret': secret },
      payload,
    });
    assert.equal(r1.statusCode, 200);
    const firstBody = JSON.parse(r1.body);
    assert.equal(firstBody.status, 'ok');

    const r2 = await app.inject({
      method: 'POST',
      url: '/api/callbacks/post-message',
      headers: { 'x-agent-key-secret': secret },
      payload,
    });
    assert.equal(r2.statusCode, 200);
    const secondBody = JSON.parse(r2.body);
    assert.equal(secondBody.status, 'ok');
    assert.notEqual(secondBody.messageId, firstBody.messageId);

    const messages = await messageStore.getByThread(ownedThreadId);
    assert.equal(messages.length, 2);
    assert.equal(socketManager.getMessages().filter((m) => m.type === 'text').length, 2);
  });

  test('agent-key callback new ID does not reuse a same-text queued source', async () => {
    const app = await createApp();
    const { secret } = await issueKey();

    const queued = messageStore.append(
      canonicalTestMessageInput({
        userId: TEST_USER,
        catId: TEST_CAT,
        content: 'same queued smoke report',
        mentions: [],
        origin: 'callback',
        timestamp: Date.now(),
        threadId: ownedThreadId,
        deliveryStatus: 'queued',
        extra: { isExplicitPost: true },
      }),
    );

    const res = await app.inject({
      method: 'POST',
      url: '/api/callbacks/post-message',
      headers: { 'x-agent-key-secret': secret },
      payload: {
        clientMessageId: 'new-independent-source',
        content: 'same queued smoke report',
        threadId: ownedThreadId,
      },
    });
    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.body);
    assert.equal(body.status, 'ok');
    assert.notEqual(body.messageId, queued.id);

    assert.equal(messageStore.size, 2);
    assert.equal(socketManager.getMessages().filter((m) => m.type === 'text').length, 1);
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

  // ---- F182 P1-1: agent_key path must use resolveCatTarget (not catRegistry.has) ----

  test('F182 P1-1: agent-key post-message with disabled targetCat returns routing_warnings (soft degradation)', async () => {
    const app = await createApp();
    const { secret } = await issueKey();

    const res = await app.inject({
      method: 'POST',
      url: '/api/callbacks/post-message',
      headers: { 'x-agent-key-secret': secret },
      payload: { content: 'hello', threadId: ownedThreadId, targetCats: ['antigravity'] },
    });

    assert.equal(res.statusCode, 200, `expected soft-degradation 200, got ${res.statusCode}: ${res.body}`);
    const body = JSON.parse(res.body);
    assert.ok(Array.isArray(body.routing_warnings), 'must have routing_warnings array');
    assert.equal(body.routing_warnings.length, 1, 'must have 1 routing warning for disabled cat');
    assert.equal(body.routing_warnings[0].kind, 'cat_disabled', 'warning kind must be cat_disabled');
    assert.equal(body.routing_warnings[0].catId, 'antigravity');
  });

  test('F182 P1-1: agent-key post-message drops disabled cat from persisted mentions', async () => {
    const app = await createApp();
    const { secret } = await issueKey();

    await app.inject({
      method: 'POST',
      url: '/api/callbacks/post-message',
      headers: { 'x-agent-key-secret': secret },
      payload: { content: 'hello', threadId: ownedThreadId, targetCats: ['antigravity'] },
    });

    const messages = await messageStore.getByThread(ownedThreadId);
    const lastMsg = messages[messages.length - 1];
    assert.ok(lastMsg, 'message must be persisted');
    assert.ok(!lastMsg.mentions.includes('antigravity'), 'disabled cat must NOT be in persisted mentions');
  });

  test('F182 P1-1: agent-key post-message with disabled targetCat includes KD-7 message field', async () => {
    const app = await createApp();
    const { secret } = await issueKey();

    const res = await app.inject({
      method: 'POST',
      url: '/api/callbacks/post-message',
      headers: { 'x-agent-key-secret': secret },
      payload: { content: 'hello', threadId: ownedThreadId, targetCats: ['antigravity'] },
    });

    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.body);
    assert.ok(typeof body.message === 'string' && body.message.length > 0, 'must have KD-7 message field');
  });

  // F182 AC-C1 allExplicitFailed: agent_key path must match invocation path contract
  test('F182 P1-1: agent-key post-message all-disabled targetCats returns isError:true + routed:[]', async () => {
    const app = await createApp();
    const { secret } = await issueKey();

    const res = await app.inject({
      method: 'POST',
      url: '/api/callbacks/post-message',
      headers: { 'x-agent-key-secret': secret },
      // 'hello' has no @mention so contentTargets=[] + antigravity is disabled → allExplicitFailed
      payload: { content: 'hello', threadId: ownedThreadId, targetCats: ['antigravity'] },
    });

    assert.equal(res.statusCode, 200, `expected 200 soft-degradation, got ${res.statusCode}: ${res.body}`);
    const body = JSON.parse(res.body);
    assert.equal(body.isError, true, 'allExplicitFailed must set isError:true');
    assert.deepEqual(body.routed, [], 'allExplicitFailed must return routed:[]');
  });
});
