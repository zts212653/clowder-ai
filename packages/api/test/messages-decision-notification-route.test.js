import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it, mock } from 'node:test';
import Fastify from 'fastify';
import webpush from 'web-push';

const { InvocationQueue } = await import('../dist/domains/cats/services/agents/invocation/InvocationQueue.js');
const { InvocationRegistry } = await import('../dist/domains/cats/services/agents/invocation/InvocationRegistry.js');
const { initPushNotificationService } = await import('../dist/domains/cats/services/push/PushNotificationService.js');

function buildDeps() {
  const invocationQueue = new InvocationQueue();
  return {
    registry: new InvocationRegistry(),
    messageStore: {
      append: mock.fn(async (msg) => ({ id: `msg-${Date.now()}`, ...msg })),
      getByThread: mock.fn(async () => []),
      getByThreadBefore: mock.fn(async () => []),
    },
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
        yield {
          type: 'text',
          catId: 'opus',
          content: '请你拍板是否合入',
          timestamp: Date.now(),
        };
        yield { type: 'done', catId: 'opus', timestamp: Date.now() };
      }),
      ackCollectedCursors: mock.fn(async () => {}),
      route: mock.fn(async function* () {
        yield { type: 'done', catId: 'opus', timestamp: Date.now() };
      }),
    },
    invocationTracker: {
      start: mock.fn(() => new AbortController()),
      tryStartThread: mock.fn(() => new AbortController()),
      complete: mock.fn(),
      has: mock.fn(() => false),
      cancel: mock.fn(() => ({ cancelled: true, catIds: ['opus'] })),
      isDeleting: mock.fn(() => false),
    },
    invocationRecordStore: {
      create: mock.fn(async () => ({
        outcome: 'created',
        invocationId: 'inv-stub',
      })),
      update: mock.fn(async () => {}),
    },
    invocationQueue,
    threadStore: {
      get: mock.fn(async () => ({
        id: 'thread-1',
        title: 'Test Thread',
        createdBy: 'test-user',
      })),
      updateTitle: mock.fn(async () => {}),
    },
  };
}

describe('POST /api/messages decision notification route policy', () => {
  let app;
  let deps;
  let notifyUserMock;

  beforeEach(async () => {
    deps = buildDeps();

    const keys = webpush.generateVAPIDKeys();
    const pushService = initPushNotificationService({
      subscriptionStore: {
        listAll: async () => [],
        listByUser: async () => [],
        upsert: async () => {},
        remove: async () => false,
        removeForUser: async () => 0,
      },
      vapidPublicKey: keys.publicKey,
      vapidPrivateKey: keys.privateKey,
      vapidSubject: 'mailto:test@example.com',
    });
    notifyUserMock = mock.fn(async () => {});
    pushService.notifyUser = notifyUserMock;

    const { messagesRoutes } = await import('../dist/routes/messages.js');
    app = Fastify();
    await app.register(messagesRoutes, deps);
    await app.ready();
  });

  afterEach(async () => {
    if (app) await app.close();
  });

  it('marks push as decision-required when cat reply asks for decision', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/messages',
      headers: { 'x-cat-cafe-user': 'user-1', 'content-type': 'application/json' },
      payload: { content: '继续', threadId: 'thread-1' },
    });

    assert.equal(res.statusCode, 200);
    await new Promise((resolve) => setTimeout(resolve, 30));

    assert.equal(notifyUserMock.mock.calls.length, 1);
    const payload = notifyUserMock.mock.calls[0].arguments[1];
    assert.ok(payload.tag.startsWith('cat-decision-'), `expected decision tag, got ${payload.tag}`);
    assert.equal(payload.data?.requiresDecision, true);
    assert.match(payload.body, /请你拍板|合入/);
  });

  it('does not classify as decision when assistant emits no text chunks', async () => {
    deps.router.routeExecution.mock.mockImplementation(async function* () {
      yield {
        type: 'tool_use',
        catId: 'opus',
        toolName: 'read_file',
        toolInput: { path: 'README.md' },
        timestamp: Date.now(),
      };
      yield { type: 'done', catId: 'opus', timestamp: Date.now() };
    });

    const res = await app.inject({
      method: 'POST',
      url: '/api/messages',
      headers: { 'x-cat-cafe-user': 'user-1', 'content-type': 'application/json' },
      payload: { content: '请你决定这个 PR 是否合入', threadId: 'thread-1' },
    });

    assert.equal(res.statusCode, 200);
    await new Promise((resolve) => setTimeout(resolve, 30));

    assert.equal(notifyUserMock.mock.calls.length, 1);
    const payload = notifyUserMock.mock.calls[0].arguments[1];
    assert.ok(
      payload.tag.startsWith('cat-reply-'),
      `expected reply tag when assistant has no text, got ${payload.tag}`,
    );
    assert.equal(payload.data?.requiresDecision, undefined);
  });
});
