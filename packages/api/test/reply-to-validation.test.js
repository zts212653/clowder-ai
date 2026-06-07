/**
 * #699 P1-2: replyTo must be validated before storing
 * RED → GREEN: tests that POST /api/messages validates the replyTo reference
 * exists in the same thread and is not deleted.
 */

import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, mock, test } from 'node:test';
import { catRegistry, createCatId } from '@cat-cafe/shared';
import Fastify from 'fastify';

const { InvocationQueue } = await import('../dist/domains/cats/services/agents/invocation/InvocationQueue.js');
const { InvocationRegistry } = await import('../dist/domains/cats/services/agents/invocation/InvocationRegistry.js');

/** Minimal cat config for registry — only fields needed by catIdSchema validation */
function stubCatConfig(id) {
  return {
    id: createCatId(id),
    name: id,
    displayName: id,
    avatar: `/avatars/${id}.png`,
    color: { primary: '#000', secondary: '#fff' },
    mentionPatterns: [`@${id}`],
    clientId: 'test',
    defaultModel: 'test',
    mcpSupport: false,
    roleDescription: 'test',
    personality: 'test',
  };
}

describe('POST /api/messages — replyTo validation', () => {
  let app;
  let messageStore;
  let deps;

  beforeEach(async () => {
    const { MessageStore } = await import('../dist/domains/cats/services/stores/ports/MessageStore.js');
    const { ThreadStore } = await import('../dist/domains/cats/services/stores/ports/ThreadStore.js');

    // Register cats so catIdSchema passes for whisper tests
    catRegistry.reset();
    for (const id of ['opus', 'codex', 'gemini']) {
      catRegistry.register(id, stubCatConfig(id));
    }

    messageStore = new MessageStore();
    const threadStore = new ThreadStore();

    deps = {
      registry: new InvocationRegistry(),
      messageStore,
      socketManager: {
        broadcastAgentMessage: mock.fn(),
        broadcastToRoom: mock.fn(),
        emitToUser: mock.fn(),
      },
      router: {
        resolveTargetsAndIntent: mock.fn(async () => ({
          targetCats: ['opus'],
          intent: { intent: 'execute' },
        })),
        routeExecution: mock.fn(async function* () {
          yield { type: 'done', catId: 'opus', timestamp: Date.now() };
        }),
        ackCollectedCursors: mock.fn(async () => {}),
        route: mock.fn(async function* () {
          yield { type: 'done' };
        }),
      },
      invocationTracker: {
        start: mock.fn(() => new AbortController()),
        startAll: mock.fn(() => new AbortController()),
        tryStartThread: mock.fn(() => new AbortController()),
        tryStartThreadAll: mock.fn(() => new AbortController()),
        complete: mock.fn(),
        completeAll: mock.fn(),
        has: mock.fn(() => false),
        cancel: mock.fn(() => ({ cancelled: true, catIds: [] })),
        cancelAll: mock.fn(() => []),
        cancelInvocation: mock.fn(() => []),
        isDeleting: mock.fn(() => false),
      },
      invocationRecordStore: {
        create: mock.fn(async () => ({
          outcome: 'created',
          invocationId: 'inv-stub',
        })),
        update: mock.fn(async () => {}),
        get: mock.fn(async () => null),
      },
      invocationQueue: new InvocationQueue(),
      queueProcessor: {
        clearPause: mock.fn(),
        onInvocationComplete: mock.fn(async () => {}),
        enqueueContinuation: mock.fn(() => ({ outcome: 'enqueued' })),
      },
      threadStore,
    };

    const { messagesRoutes } = await import('../dist/routes/messages.js');
    app = Fastify();
    await app.register(messagesRoutes, deps);
    await app.ready();
  });

  afterEach(async () => {
    if (app) await app.close();
    catRegistry.reset();
  });

  async function createThread(title = 'Test thread') {
    return deps.threadStore.create('default-user', title);
  }

  test('silently drops replyTo referencing non-existent message', async () => {
    const thread = await createThread();

    const res = await app.inject({
      method: 'POST',
      url: '/api/messages',
      payload: {
        content: 'reply to ghost',
        threadId: thread.id,
        replyTo: 'non-existent-id',
      },
    });

    assert.equal(res.statusCode, 200);
    const messages = messageStore.getByThread(thread.id);
    const sent = messages.find((m) => m.content === 'reply to ghost');
    assert.ok(sent, 'message should be stored');
    assert.equal(sent.replyTo, undefined, 'invalid replyTo should be dropped');
  });

  test('silently drops replyTo referencing message in different thread', async () => {
    const thread1 = await createThread('Thread 1');
    const thread2 = await createThread('Thread 2');

    const otherThreadMsg = messageStore.append({
      userId: 'default-user',
      catId: null,
      content: 'message in thread 2',
      mentions: [],
      timestamp: 1000,
      threadId: thread2.id,
    });

    const res = await app.inject({
      method: 'POST',
      url: '/api/messages',
      payload: {
        content: 'cross-thread reply',
        threadId: thread1.id,
        replyTo: otherThreadMsg.id,
      },
    });

    assert.equal(res.statusCode, 200);
    const messages = messageStore.getByThread(thread1.id);
    const sent = messages.find((m) => m.content === 'cross-thread reply');
    assert.ok(sent, 'message should be stored');
    assert.equal(sent.replyTo, undefined, 'cross-thread replyTo should be dropped');
  });

  test('silently drops replyTo referencing deleted message', async () => {
    const thread = await createThread();

    const deleted = messageStore.append({
      userId: 'default-user',
      catId: null,
      content: 'will be deleted',
      mentions: [],
      timestamp: 1000,
      threadId: thread.id,
    });
    messageStore.softDelete(deleted.id);

    const res = await app.inject({
      method: 'POST',
      url: '/api/messages',
      payload: {
        content: 'reply to deleted',
        threadId: thread.id,
        replyTo: deleted.id,
      },
    });

    assert.equal(res.statusCode, 200);
    const messages = messageStore.getByThread(thread.id);
    const sent = messages.find((m) => m.content === 'reply to deleted');
    assert.ok(sent, 'message should be stored');
    assert.equal(sent.replyTo, undefined, 'deleted-message replyTo should be dropped');
  });

  test('silently drops replyTo referencing queued (undelivered) message', async () => {
    const thread = await createThread();

    const queued = messageStore.append({
      userId: 'default-user',
      catId: null,
      content: 'queued message',
      mentions: [],
      timestamp: 1000,
      threadId: thread.id,
      deliveryStatus: 'queued',
    });

    const res = await app.inject({
      method: 'POST',
      url: '/api/messages',
      payload: {
        content: 'reply to queued',
        threadId: thread.id,
        replyTo: queued.id,
      },
    });

    assert.equal(res.statusCode, 200);
    const messages = messageStore.getByThread(thread.id);
    const sent = messages.find((m) => m.content === 'reply to queued');
    assert.ok(sent, 'message should be stored');
    assert.equal(sent.replyTo, undefined, 'queued-message replyTo should be dropped');
  });

  test('silently drops replyTo referencing canceled message', async () => {
    const thread = await createThread();

    const canceled = messageStore.append({
      userId: 'default-user',
      catId: null,
      content: 'canceled message',
      mentions: [],
      timestamp: 1000,
      threadId: thread.id,
      deliveryStatus: 'canceled',
    });

    const res = await app.inject({
      method: 'POST',
      url: '/api/messages',
      payload: {
        content: 'reply to canceled',
        threadId: thread.id,
        replyTo: canceled.id,
      },
    });

    assert.equal(res.statusCode, 200);
    const messages = messageStore.getByThread(thread.id);
    const sent = messages.find((m) => m.content === 'reply to canceled');
    assert.ok(sent, 'message should be stored');
    assert.equal(sent.replyTo, undefined, 'canceled-message replyTo should be dropped');
  });

  test('preserves valid replyTo referencing message in same thread', async () => {
    const thread = await createThread();

    const target = messageStore.append({
      userId: 'default-user',
      catId: null,
      content: 'original message',
      mentions: [],
      timestamp: 1000,
      threadId: thread.id,
    });

    const res = await app.inject({
      method: 'POST',
      url: '/api/messages',
      payload: {
        content: 'valid reply',
        threadId: thread.id,
        replyTo: target.id,
      },
    });

    assert.equal(res.statusCode, 200);
    const messages = messageStore.getByThread(thread.id);
    const sent = messages.find((m) => m.content === 'valid reply');
    assert.ok(sent, 'message should be stored');
    assert.equal(sent.replyTo, target.id, 'valid replyTo should be preserved');
  });

  // ── Whisper visibility leak prevention ──

  test('silently drops replyTo when public message quotes a whisper', async () => {
    const thread = await createThread();

    const whisperMsg = messageStore.append({
      userId: 'default-user',
      catId: 'opus',
      content: 'secret whisper content',
      mentions: [],
      timestamp: 1000,
      threadId: thread.id,
      visibility: 'whisper',
      whisperTo: ['codex'],
    });

    const res = await app.inject({
      method: 'POST',
      url: '/api/messages',
      payload: {
        content: 'public reply to whisper',
        threadId: thread.id,
        replyTo: whisperMsg.id,
      },
    });

    assert.equal(res.statusCode, 200);
    const messages = messageStore.getByThread(thread.id);
    const sent = messages.find((m) => m.content === 'public reply to whisper');
    assert.ok(sent, 'message should be stored');
    assert.equal(sent.replyTo, undefined, 'public reply to whisper should drop replyTo');
  });

  test('silently drops replyTo when whisper has wider audience than parent whisper', async () => {
    const thread = await createThread();

    // Parent whispered only to codex
    const whisperMsg = messageStore.append({
      userId: 'default-user',
      catId: 'opus',
      content: 'private to codex only',
      mentions: [],
      timestamp: 1000,
      threadId: thread.id,
      visibility: 'whisper',
      whisperTo: ['codex'],
    });

    // Reply whispered to codex AND gemini — gemini can't see parent
    const res = await app.inject({
      method: 'POST',
      url: '/api/messages',
      payload: {
        content: 'wider whisper reply',
        threadId: thread.id,
        replyTo: whisperMsg.id,
        visibility: 'whisper',
        whisperTo: ['codex', 'gemini'],
      },
    });

    assert.equal(res.statusCode, 200);
    const messages = messageStore.getByThread(thread.id);
    const sent = messages.find((m) => m.content === 'wider whisper reply');
    assert.ok(sent, 'message should be stored');
    assert.equal(sent.replyTo, undefined, 'wider-audience whisper reply should drop replyTo');
  });

  test('preserves replyTo when whisper replies to whisper with same recipients', async () => {
    const thread = await createThread();

    const whisperMsg = messageStore.append({
      userId: 'default-user',
      catId: 'opus',
      content: 'whisper to codex',
      mentions: [],
      timestamp: 1000,
      threadId: thread.id,
      visibility: 'whisper',
      whisperTo: ['codex'],
    });

    // Same-audience whisper reply — safe, codex already saw the parent
    const res = await app.inject({
      method: 'POST',
      url: '/api/messages',
      payload: {
        content: 'same-audience whisper reply',
        threadId: thread.id,
        replyTo: whisperMsg.id,
        visibility: 'whisper',
        whisperTo: ['codex'],
      },
    });

    assert.equal(res.statusCode, 200);
    const messages = messageStore.getByThread(thread.id);
    const sent = messages.find((m) => m.content === 'same-audience whisper reply');
    assert.ok(sent, 'message should be stored');
    assert.equal(sent.replyTo, whisperMsg.id, 'same-audience whisper replyTo should be preserved');
  });
});
