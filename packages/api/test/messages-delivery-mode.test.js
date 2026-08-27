/**
 * POST /api/messages deliveryMode tests (F39)
 * Tests queue/force/immediate routing logic.
 */

import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it, mock } from 'node:test';
import Fastify from 'fastify';

const { InvocationQueue } = await import('../dist/domains/cats/services/agents/invocation/InvocationQueue.js');
const { InvocationRegistry } = await import('../dist/domains/cats/services/agents/invocation/InvocationRegistry.js');
const { InvocationTracker } = await import('../dist/domains/cats/services/agents/invocation/InvocationTracker.js');
const { QueueProcessor } = await import('../dist/domains/cats/services/agents/invocation/QueueProcessor.js');
const { buildCapsuleFromRouteState, completeCapsuleForSeal } = await import(
  '../dist/domains/cats/services/agents/invocation/CollaborationContinuityCapsule.js'
);

const OPUS_SLOT_KEY = JSON.stringify(['thread-1', 'opus']);
const CODEX_SLOT_KEY = JSON.stringify(['thread-1', 'codex']);

function deferred() {
  let resolve;
  const promise = new Promise((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

/** Build a complete deps object for messagesRoutes */
function buildDeps(overrides = {}) {
  const invocationQueue = new InvocationQueue();
  return {
    registry: new InvocationRegistry(),
    messageStore: {
      append: mock.fn(async (msg) => ({ id: `msg-${Date.now()}`, ...msg })),
      getByThread: mock.fn(async () => []),
      getByThreadBefore: mock.fn(async () => []),
      // Whole-message selection resolves the canonical bubble group, so the timeline this double
      // exposes must contain whatever source record the individual test stubbed via getById.
      getByThreadAfter: mock.fn(async function getByThreadAfter(threadId) {
        const source = await this.getById?.('source-message-1');
        return source && source.threadId === threadId ? [source] : [];
      }),
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
      resolveExplicitTargets: mock.fn(async (targetCats) => targetCats),
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
      cancel: mock.fn(() => ({ cancelled: true, catIds: ['opus'] })),
      cancelAll: mock.fn(() => ({ catIds: ['opus'], executionIds: [] })),
      cancelInvocation: mock.fn(() => ['opus']),
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
    invocationQueue,
    queueProcessor: {
      clearPause: mock.fn(),
      onInvocationComplete: mock.fn(async () => {}),
      enqueueContinuation: mock.fn(async () => ({ outcome: 'enqueued' })),
    },
    threadStore: {
      get: mock.fn(async () => ({
        id: 'thread-1',
        title: 'Test Thread',
        createdBy: 'test-user',
      })),
      updateTitle: mock.fn(async () => {}),
    },
    ...overrides,
  };
}

function wireRealExecutionOwners(deps) {
  const tracker = new InvocationTracker();
  deps.invocationTracker = tracker;
  const processor = new QueueProcessor(
    /** @type {any} */ ({
      queue: deps.invocationQueue,
      invocationTracker: tracker,
      invocationRecordStore: deps.invocationRecordStore,
      router: deps.router,
      socketManager: deps.socketManager,
      messageStore: {
        ...deps.messageStore,
        getById: mock.fn(async () => null),
      },
      log: {
        info: mock.fn(),
        warn: mock.fn(),
        error: mock.fn(),
      },
    }),
  );
  deps.queueProcessor = processor;
  return { tracker, processor };
}

describe('POST /api/messages deliveryMode', () => {
  let app;
  let deps;

  beforeEach(async () => {
    deps = buildDeps();
    const { messagesRoutes } = await import('../dist/routes/messages.js');
    app = Fastify();
    await app.register(messagesRoutes, deps);
    await app.ready();
  });

  afterEach(async () => {
    if (app) await app.close();
  });

  it('queue mode + active invocation → enqueues and returns 202', async () => {
    // Simulate active invocation
    deps.invocationTracker.has.mock.mockImplementation(() => true);

    const res = await app.inject({
      method: 'POST',
      url: '/api/messages',
      headers: { 'x-cat-cafe-user': 'user-1', 'content-type': 'application/json' },
      payload: {
        content: '你好猫猫',
        threadId: 'thread-1',
        deliveryMode: 'queue',
      },
    });

    assert.equal(res.statusCode, 202);
    const body = JSON.parse(res.body);
    assert.equal(body.status, 'queued');
    assert.equal(body.merged, false);
    assert.ok(body.entryId);
    assert.equal(body.queuePosition, 1);
    assert.match(body.userMessageId, /^msg-/);

    // Should NOT have created InvocationRecord (queued, not executing)
    assert.equal(deps.invocationRecordStore.create.mock.calls.length, 0);

    // Should have written user message to messageStore
    assert.equal(deps.messageStore.append.mock.calls.length, 1);
    const queuedWrite = deps.messageStore.append.mock.calls[0].arguments[0];
    assert.equal(queuedWrite.deliveryStatus, 'queued');
    assert.equal(queuedWrite.queueCustody.entryId, body.entryId);
    assert.equal(queuedWrite.queueCustody.status, 'queued');
    assert.deepEqual(queuedWrite.queueCustody.pendingTargetCats, ['opus']);

    // Should have emitted queue_updated to user
    const emitCalls = deps.socketManager.emitToUser.mock.calls;
    const queueUpdate = emitCalls.find((c) => c.arguments[1] === 'queue_updated');
    assert.ok(queueUpdate, 'should emit queue_updated');
    assert.equal(queueUpdate.arguments[2].action, 'enqueued');
    assert.equal(deps.invocationQueue.list('thread-1', 'user-1')[0].ownerAuthProvenance, 'strict');
    assert.equal(
      Object.hasOwn(queueUpdate.arguments[2].queue[0], 'ownerAuthProvenance'),
      false,
      'internal auth provenance must not enter queue_updated payloads',
    );
  });

  it('queue mode replay with same idempotencyKey does not append duplicate message', async () => {
    deps.invocationTracker.has.mock.mockImplementation(() => true);

    const first = await app.inject({
      method: 'POST',
      url: '/api/messages',
      headers: { 'x-cat-cafe-user': 'user-1', 'content-type': 'application/json' },
      payload: {
        content: '会重放',
        threadId: 'thread-1',
        deliveryMode: 'queue',
        idempotencyKey: '11111111-1111-4111-8111-111111111111',
      },
    });
    assert.equal(first.statusCode, 202);
    const firstBody = JSON.parse(first.body);

    const replay = await app.inject({
      method: 'POST',
      url: '/api/messages',
      headers: { 'x-cat-cafe-user': 'user-1', 'content-type': 'application/json' },
      payload: {
        content: '会重放',
        threadId: 'thread-1',
        deliveryMode: 'queue',
        idempotencyKey: '11111111-1111-4111-8111-111111111111',
      },
    });
    assert.equal(replay.statusCode, 202);
    const replayBody = JSON.parse(replay.body);

    assert.equal(deps.messageStore.append.mock.calls.length, 1, 'replay should not append again');
    assert.equal(deps.invocationQueue.list('thread-1', 'user-1').length, 1, 'replay should not add a new queue row');
    assert.equal(replayBody.entryId, firstBody.entryId, 'replay should point to existing queue entry');
    assert.equal(replayBody.userMessageId, firstBody.userMessageId, 'replay should reuse original user message');
  });

  it('F294 admits one refs-only Bundle message and routes only the explicit cats', async () => {
    const sourceBody = 'private source body must never enter the durable target summary';
    deps.messageStore.getById = mock.fn(async (messageId) =>
      messageId === 'source-message-1'
        ? {
            id: messageId,
            threadId: 'source-thread',
            userId: 'user-1',
            catId: 'opus',
            content: sourceBody,
            mentions: [],
            timestamp: 1000,
          }
        : null,
    );
    deps.threadStore.get = mock.fn(async (threadId) => ({
      id: threadId,
      title: threadId === 'source-thread' ? 'Source Thread' : 'Target Thread',
      createdBy: 'user-1',
      participants: [],
    }));

    const res = await app.inject({
      method: 'POST',
      url: '/api/messages',
      headers: { 'x-cat-cafe-user': 'user-1', 'content-type': 'application/json' },
      payload: {
        content: '',
        threadId: 'thread-1',
        deliveryMode: 'immediate',
        idempotencyKey: '22222222-2222-4222-8222-222222222222',
        messageBundle: {
          sourceThreadId: 'source-thread',
          note: 'please focus on the source decision',
          items: [{ kind: 'message', messageId: 'source-message-1' }],
          targetCats: ['opus'],
        },
      },
    });
    await new Promise((resolve) => setImmediate(resolve));

    assert.equal(res.statusCode, 200, res.body);
    assert.equal(deps.router.resolveTargetsAndIntent.mock.calls.length, 0, 'Bundle prose must not drive routing');
    assert.deepEqual(deps.router.resolveExplicitTargets.mock.calls[0].arguments[0], ['opus']);
    const initialAppend = deps.messageStore.append.mock.calls[0].arguments[0];
    assert.deepEqual(initialAppend.mentions, ['opus']);
    assert.deepEqual(initialAppend.extra.messageBundle, {
      v: 1,
      sourceThreadId: 'source-thread',
      note: 'please focus on the source decision',
      items: [{ kind: 'message', messageId: 'source-message-1' }],
    });
    assert.equal(initialAppend.content.includes(sourceBody), false, 'durable summary must not copy source bodies');
    assert.match(initialAppend.content, /Source Thread/);
    const prompt = deps.router.routeExecution.mock.calls[0].arguments[1];
    assert.notEqual(prompt, initialAppend.content);
    assert.match(prompt, /\[Message Bundle\]/);
    assert.match(prompt, /Bundle ID: /);
    assert.match(prompt, /Source thread: "Source Thread" \(source-thread\)/);
    assert.match(prompt, /Source author: cat:@opus/);
    assert.match(prompt, /Source message ref: source-message-1/);
    assert.match(prompt, /Bundle note by user:user-1:\nplease focus on the source decision/);
    assert.match(prompt, /private source body must never enter the durable target summary/);
    const routeOptions = deps.router.routeExecution.mock.calls[0].arguments[6];
    assert.deepEqual(routeOptions.persistedPromptMessageIds, [initialAppend.id ?? JSON.parse(res.body).userMessageId]);
    assert.equal(routeOptions.persistedPromptMessages[0].messageId, JSON.parse(res.body).userMessageId);
    assert.equal(routeOptions.persistedPromptMessages[0].forceExplicitProjection, true);
    assert.deepEqual(deps.router.routeExecution.mock.calls[0].arguments[4], ['opus']);
  });

  it('F294 immediate replay reuses one Bundle identity without a second append or wake', async () => {
    deps.messageStore.getById = mock.fn(async () => ({
      id: 'source-message-1',
      threadId: 'source-thread',
      userId: 'user-1',
      catId: null,
      content: 'source body',
      mentions: [],
      timestamp: 1000,
    }));
    deps.threadStore.get = mock.fn(async (threadId) => ({
      id: threadId,
      title: threadId === 'source-thread' ? 'Source Thread' : 'Target Thread',
      createdBy: 'user-1',
      participants: [],
    }));

    let createCount = 0;
    let storedUserMessageId;
    deps.invocationRecordStore.create = mock.fn(async () => ({
      outcome: createCount++ === 0 ? 'created' : 'duplicate',
      invocationId: 'inv-f294-replay',
    }));
    deps.invocationRecordStore.update = mock.fn(async (_invocationId, patch) => {
      if (patch.userMessageId) storedUserMessageId = patch.userMessageId;
    });
    deps.invocationRecordStore.get = mock.fn(async () => ({
      invocationId: 'inv-f294-replay',
      userMessageId: storedUserMessageId,
    }));

    const payload = {
      content: '',
      threadId: 'thread-1',
      deliveryMode: 'immediate',
      idempotencyKey: '44444444-4444-4444-8444-444444444444',
      messageBundle: {
        sourceThreadId: 'source-thread',
        items: [{ kind: 'message', messageId: 'source-message-1' }],
        targetCats: ['opus'],
      },
    };

    const first = await app.inject({
      method: 'POST',
      url: '/api/messages',
      headers: { 'x-cat-cafe-user': 'user-1', 'content-type': 'application/json' },
      payload,
    });
    await new Promise((resolve) => setImmediate(resolve));
    const replay = await app.inject({
      method: 'POST',
      url: '/api/messages',
      headers: { 'x-cat-cafe-user': 'user-1', 'content-type': 'application/json' },
      payload,
    });
    await new Promise((resolve) => setImmediate(resolve));

    assert.equal(first.statusCode, 200, first.body);
    assert.equal(replay.statusCode, 200, replay.body);
    assert.equal(JSON.parse(replay.body).status, 'duplicate');
    assert.equal(JSON.parse(replay.body).messageBundleId, JSON.parse(first.body).messageBundleId);
    assert.equal(deps.messageStore.append.mock.calls.length, 1, 'replay must not append a second Bundle card');
    assert.equal(deps.router.routeExecution.mock.calls.length, 1, 'replay must not wake the target cat twice');
    assert.equal(
      deps.socketManager.emitToUser.mock.calls.filter((call) => call.arguments[1] === 'thread_updated').length,
      1,
      'replay must not republish participant mutation',
    );
  });

  it('F294 queue replay keeps one Bundle identity and persists the carrier in the initial append', async () => {
    deps.invocationTracker.has.mock.mockImplementation(() => true);
    deps.messageStore.getById = mock.fn(async () => ({
      id: 'source-message-1',
      threadId: 'source-thread',
      userId: 'user-1',
      catId: null,
      content: 'source body',
      mentions: [],
      timestamp: 1000,
    }));
    deps.threadStore.get = mock.fn(async (threadId) => ({
      id: threadId,
      title: threadId === 'source-thread' ? 'Source Thread' : 'Target Thread',
      createdBy: 'user-1',
      participants: [],
    }));
    const payload = {
      content: '',
      threadId: 'thread-1',
      deliveryMode: 'queue',
      idempotencyKey: '33333333-3333-4333-8333-333333333333',
      messageBundle: {
        sourceThreadId: 'source-thread',
        items: [{ kind: 'message', messageId: 'source-message-1' }],
        targetCats: ['opus'],
      },
    };

    const first = await app.inject({
      method: 'POST',
      url: '/api/messages',
      headers: { 'x-cat-cafe-user': 'user-1', 'content-type': 'application/json' },
      payload,
    });
    const replay = await app.inject({
      method: 'POST',
      url: '/api/messages',
      headers: { 'x-cat-cafe-user': 'user-1', 'content-type': 'application/json' },
      payload,
    });

    assert.equal(first.statusCode, 202, first.body);
    assert.equal(replay.statusCode, 202, replay.body);
    assert.equal(deps.messageStore.append.mock.calls.length, 1);
    const initialAppend = deps.messageStore.append.mock.calls[0].arguments[0];
    assert.equal(initialAppend.deliveryStatus, 'queued');
    assert.deepEqual(initialAppend.extra.messageBundle.items, [{ kind: 'message', messageId: 'source-message-1' }]);
    assert.equal(initialAppend.content.includes('source body'), false);
    assert.equal(JSON.parse(replay.body).userMessageId, JSON.parse(first.body).userMessageId);
  });

  it('F294 rejects mixed carriers and unauthorized targets before any append, queue, or invocation', async () => {
    deps.messageStore.getById = mock.fn(async () => ({
      id: 'source-message-1',
      threadId: 'source-thread',
      userId: 'user-1',
      catId: null,
      content: 'source body',
      mentions: [],
      timestamp: 1000,
    }));
    deps.threadStore.get = mock.fn(async (threadId) => ({
      id: threadId,
      title: 'Foreign Target',
      createdBy: threadId === 'thread-1' ? 'another-user' : 'user-1',
      participants: [],
    }));

    const res = await app.inject({
      method: 'POST',
      url: '/api/messages',
      headers: { 'x-cat-cafe-user': 'user-1', 'content-type': 'application/json' },
      payload: {
        content: 'client-authored body is forbidden for a Bundle target message',
        threadId: 'thread-1',
        replyTo: 'reply-parent',
        visibility: 'whisper',
        whisperTo: ['opus'],
        messageBundle: {
          sourceThreadId: 'source-thread',
          items: [{ kind: 'message', messageId: 'source-message-1' }],
          targetCats: ['opus'],
        },
      },
    });

    assert.equal(res.statusCode, 400, res.body);
    assert.equal(deps.messageStore.append.mock.calls.length, 0);
    assert.equal(deps.invocationRecordStore.create.mock.calls.length, 0);
    assert.equal(deps.invocationQueue.list('thread-1', 'user-1').length, 0);
    assert.equal(deps.router.resolveTargetsAndIntent.mock.calls.length, 0);
  });

  it('F294 rejects an over-limit explicit target set before routing', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/messages',
      headers: { 'x-cat-cafe-user': 'user-1', 'content-type': 'application/json' },
      payload: {
        content: '',
        threadId: 'thread-1',
        messageBundle: {
          sourceThreadId: 'source-thread',
          items: [{ kind: 'message', messageId: 'source-message-1' }],
          targetCats: Array.from({ length: 11 }, (_, index) => `cat-${index}`),
        },
      },
    });

    assert.equal(res.statusCode, 400, res.body);
    assert.equal(deps.router.resolveExplicitTargets.mock.calls.length, 0);
    assert.equal(deps.messageStore.append.mock.calls.length, 0);
  });

  it('F294 rejects an unauthorized target before reading sources or creating side effects', async () => {
    deps.messageStore.getById = mock.fn(async () => {
      throw new Error('source resolution must not run before target authorization');
    });
    deps.threadStore.get = mock.fn(async (threadId) => ({
      id: threadId,
      title: 'Foreign Target',
      createdBy: threadId === 'thread-1' ? 'another-user' : 'user-1',
      participants: [],
    }));

    const res = await app.inject({
      method: 'POST',
      url: '/api/messages',
      headers: { 'x-cat-cafe-user': 'user-1', 'content-type': 'application/json' },
      payload: {
        content: '',
        threadId: 'thread-1',
        messageBundle: {
          sourceThreadId: 'source-thread',
          items: [{ kind: 'message', messageId: 'source-message-1' }],
          targetCats: ['opus'],
        },
      },
    });

    assert.equal(res.statusCode, 403, res.body);
    assert.equal(deps.messageStore.getById.mock.calls.length, 0);
    assert.equal(deps.router.resolveExplicitTargets.mock.calls.length, 0);
    assert.equal(deps.messageStore.append.mock.calls.length, 0);
    assert.equal(deps.invocationRecordStore.create.mock.calls.length, 0);
  });

  it('F294 rejects an unavailable explicit cat set without fallback or side effects', async () => {
    deps.messageStore.getById = mock.fn(async () => ({
      id: 'source-message-1',
      threadId: 'source-thread',
      userId: 'user-1',
      catId: null,
      content: 'source body',
      mentions: [],
      timestamp: 1000,
    }));
    deps.threadStore.get = mock.fn(async (threadId) => ({
      id: threadId,
      title: threadId === 'source-thread' ? 'Source Thread' : 'Target Thread',
      createdBy: 'user-1',
      participants: [],
    }));
    deps.router.resolveExplicitTargets.mock.mockImplementation(async () => []);

    const res = await app.inject({
      method: 'POST',
      url: '/api/messages',
      headers: { 'x-cat-cafe-user': 'user-1', 'content-type': 'application/json' },
      payload: {
        content: '',
        threadId: 'thread-1',
        messageBundle: {
          sourceThreadId: 'source-thread',
          items: [{ kind: 'message', messageId: 'source-message-1' }],
          targetCats: ['missing-cat'],
        },
      },
    });

    assert.equal(res.statusCode, 400, res.body);
    assert.equal(deps.router.resolveTargetsAndIntent.mock.calls.length, 0);
    assert.equal(deps.messageStore.append.mock.calls.length, 0);
    assert.equal(deps.invocationRecordStore.create.mock.calls.length, 0);
  });

  it('F294 rejects a Bundle when the queue is full without creating a ghost card or invocation', async () => {
    deps.invocationTracker.has.mock.mockImplementation(() => true);
    deps.threadStore.addParticipants = mock.fn(async () => {});
    deps.messageStore.getById = mock.fn(async () => ({
      id: 'source-message-1',
      threadId: 'source-thread',
      userId: 'user-1',
      catId: null,
      content: 'source body',
      mentions: [],
      timestamp: 1000,
    }));
    deps.threadStore.get = mock.fn(async (threadId) => ({
      id: threadId,
      title: threadId === 'source-thread' ? 'Source Thread' : 'Target Thread',
      createdBy: 'user-1',
      participants: [],
    }));
    for (let i = 0; i < 5; i++) {
      deps.invocationQueue.enqueue({
        ownerAuthProvenance: 'unknown',
        threadId: 'thread-1',
        userId: 'user-1',
        content: `existing ${i}`,
        source: 'user',
        targetCats: [`cat${i}`],
        intent: 'execute',
      });
    }

    const res = await app.inject({
      method: 'POST',
      url: '/api/messages',
      headers: { 'x-cat-cafe-user': 'user-1', 'content-type': 'application/json' },
      payload: {
        content: '',
        threadId: 'thread-1',
        deliveryMode: 'queue',
        messageBundle: {
          sourceThreadId: 'source-thread',
          items: [{ kind: 'message', messageId: 'source-message-1' }],
          targetCats: ['opus'],
        },
      },
    });

    assert.equal(res.statusCode, 429, res.body);
    assert.equal(deps.messageStore.append.mock.calls.length, 0);
    assert.equal(deps.invocationRecordStore.create.mock.calls.length, 0);
    assert.equal(deps.invocationQueue.list('thread-1', 'user-1').length, 5);
    assert.equal(deps.threadStore.addParticipants.mock.calls.length, 0);
    assert.equal(
      deps.socketManager.emitToUser.mock.calls.some((call) => call.arguments[1] === 'thread_updated'),
      false,
    );
  });

  it('F294 forbids Message Bundle submission through multipart instead of silently sending ordinary content', async () => {
    const boundary = '----cat-cafe-f294-boundary';
    const payload = Buffer.concat([
      Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="content"\r\n\r\nshould not send\r\n`),
      Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="threadId"\r\n\r\nthread-1\r\n`),
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="messageBundle"\r\n\r\n${JSON.stringify({ sourceThreadId: 'source-thread', items: [{ kind: 'message', messageId: 'source-message-1' }], targetCats: ['opus'] })}\r\n`,
      ),
      Buffer.from(`--${boundary}--\r\n`),
    ]);

    const res = await app.inject({
      method: 'POST',
      url: '/api/messages',
      headers: {
        'x-cat-cafe-user': 'user-1',
        'content-type': `multipart/form-data; boundary=${boundary}`,
      },
      payload,
    });

    assert.equal(res.statusCode, 400, res.body);
    assert.deepEqual(JSON.parse(res.body), { error: 'Message Bundle does not support multipart uploads' });
    assert.equal(deps.messageStore.append.mock.calls.length, 0);
    assert.equal(deps.invocationRecordStore.create.mock.calls.length, 0);
  });

  it('queue mode → same-user consecutive messages are independent entries (F175: no merge)', async () => {
    deps.invocationTracker.has.mock.mockImplementation(() => true);

    // First message
    await app.inject({
      method: 'POST',
      url: '/api/messages',
      headers: { 'x-cat-cafe-user': 'user-1', 'content-type': 'application/json' },
      payload: { content: '第一条', threadId: 'thread-1', deliveryMode: 'queue' },
    });

    // Second message — same user, same target → independent entry (F175)
    const res = await app.inject({
      method: 'POST',
      url: '/api/messages',
      headers: { 'x-cat-cafe-user': 'user-1', 'content-type': 'application/json' },
      payload: { content: '第二条', threadId: 'thread-1', deliveryMode: 'queue' },
    });

    assert.equal(res.statusCode, 202);
    const body = JSON.parse(res.body);
    assert.equal(body.status, 'queued');
    assert.equal(body.merged, false, 'F175: no merge, each message is independent');

    // Queue should have 2 separate entries
    const queue = deps.invocationQueue.list('thread-1', 'user-1');
    assert.equal(queue.length, 2);
    assert.equal(queue[0].content, '第一条');
    assert.equal(queue[1].content, '第二条');
  });

  it('queue mode → returns 429 when queue full (no ghost message)', async () => {
    deps.invocationTracker.has.mock.mockImplementation(() => true);

    // Fill queue to capacity (5 entries with different targets to prevent merge)
    for (let i = 0; i < 5; i++) {
      deps.invocationQueue.enqueue({
        ownerAuthProvenance: 'unknown',
        threadId: 'thread-1',
        userId: 'user-1',
        content: `msg ${i}`,
        source: 'user',
        targetCats: [`cat${i}`],
        intent: 'execute',
      });
    }

    const res = await app.inject({
      method: 'POST',
      url: '/api/messages',
      headers: { 'x-cat-cafe-user': 'user-1', 'content-type': 'application/json' },
      payload: { content: 'overflow', threadId: 'thread-1', deliveryMode: 'queue' },
    });

    assert.equal(res.statusCode, 429);
    const body = JSON.parse(res.body);
    assert.equal(body.code, 'QUEUE_FULL');

    // Should NOT have written to messageStore (no ghost message)
    assert.equal(deps.messageStore.append.mock.calls.length, 0);

    // Should have emitted queue_full_warning
    const emitCalls = deps.socketManager.emitToUser.mock.calls;
    const fullWarning = emitCalls.find((c) => c.arguments[1] === 'queue_full_warning');
    assert.ok(fullWarning, 'should emit queue_full_warning');
  });

  it('queue mode → messageStore failure rolls back queue entry', async () => {
    deps.invocationTracker.has.mock.mockImplementation(() => true);
    deps.messageStore.append.mock.mockImplementation(async () => {
      throw new Error('DB write failed');
    });

    const res = await app.inject({
      method: 'POST',
      url: '/api/messages',
      headers: { 'x-cat-cafe-user': 'user-1', 'content-type': 'application/json' },
      payload: { content: '会失败', threadId: 'thread-1', deliveryMode: 'queue' },
    });

    // Fastify catches the thrown error and returns 500
    assert.equal(res.statusCode, 500);

    // The queue should be empty (entry was rolled back)
    const queue = deps.invocationQueue.list('thread-1', 'user-1');
    assert.equal(queue.length, 0, 'queue entry should be rolled back on messageStore failure');
  });

  it('force mode → cancels active invocation then executes immediately', async () => {
    deps.invocationTracker.has.mock.mockImplementation(() => true);

    const _res = await app.inject({
      method: 'POST',
      url: '/api/messages',
      headers: { 'x-cat-cafe-user': 'user-1', 'content-type': 'application/json' },
      payload: { content: '强制发送', threadId: 'thread-1', deliveryMode: 'force' },
    });

    // F-parallel-cancel (cloud #6): force = scoped preempt of the TARGET invocation → cancelInvocation
    // (not cancelAll, which would also abort an unrelated side-dispatch in the same thread).
    assert.ok(
      deps.invocationTracker.cancelInvocation.mock.calls.length > 0,
      'force should cancelInvocation (scoped preempt) the active invocation',
    );

    // Should have broadcast cancel messages
    const broadcastCalls = deps.socketManager.broadcastAgentMessage.mock.calls;
    const cancelMsg = broadcastCalls.find((c) => c.arguments[0]?.type === 'system_info');
    assert.ok(cancelMsg, 'should broadcast cancel system_info');

    // Should have proceeded to create InvocationRecord (immediate path)
    assert.ok(deps.invocationRecordStore.create.mock.calls.length > 0);
  });

  it('force mode acquires the replacement through QueueProcessor joint ownership', async () => {
    deps.invocationTracker.has.mock.mockImplementation(() => true);
    const replacement = new AbortController();
    deps.queueProcessor.acquireExternalExecution = mock.fn((_threadId, _targetCats, _userId, options) => {
      options.onOwnershipValidated?.();
      return replacement;
    });

    const res = await app.inject({
      method: 'POST',
      url: '/api/messages',
      headers: { 'x-cat-cafe-user': 'user-1', 'content-type': 'application/json' },
      payload: { content: '原子替换', threadId: 'thread-1', deliveryMode: 'force' },
    });

    assert.equal(res.statusCode, 200);
    assert.equal(deps.queueProcessor.acquireExternalExecution.mock.calls.length, 1);
    const acquisitionArgs = deps.queueProcessor.acquireExternalExecution.mock.calls[0].arguments;
    assert.equal(acquisitionArgs[0], 'thread-1');
    assert.deepEqual(acquisitionArgs[1], ['opus']);
    assert.equal(acquisitionArgs[2], 'user-1');
    assert.equal(acquisitionArgs[3].mode, 'replacement');
    assert.equal(acquisitionArgs[3].executionId, 'inv-stub');
    assert.equal(typeof acquisitionArgs[3].onOwnershipValidated, 'function');
    assert.equal(deps.invocationTracker.cancelInvocation.mock.calls.length, 1);
  });

  it('force mode cancels a same-user invocation that arrives while record creation is pending', async () => {
    await app.close();
    deps = buildDeps();
    const forceCreate = deferred();
    deps.invocationRecordStore.create.mock.mockImplementation(async () => forceCreate.promise);
    const { tracker } = wireRealExecutionOwners(deps);

    const { messagesRoutes } = await import('../dist/routes/messages.js');
    app = Fastify();
    await app.register(messagesRoutes, deps);
    await app.ready();

    const responsePromise = app.inject({
      method: 'POST',
      url: '/api/messages',
      headers: { 'x-cat-cafe-user': 'user-1', 'content-type': 'application/json' },
      payload: { content: '创建记录期间也要完整抢占', threadId: 'thread-1', deliveryMode: 'force' },
    });
    while (deps.invocationRecordStore.create.mock.calls.length === 0) {
      await new Promise((resolve) => setImmediate(resolve));
    }

    const lateController = tracker.startAll('thread-1', ['opus', 'codex'], 'user-1', 'inv-late');
    assert.equal(tracker.classifyExecutionId('thread-1', 'codex', 'inv-late'), 'matching');

    forceCreate.resolve({ outcome: 'created', invocationId: 'inv-force' });
    const res = await responsePromise;
    await new Promise((resolve) => setImmediate(resolve));

    assert.equal(res.statusCode, 200);
    assert.equal(lateController.signal.aborted, true, 'late same-user invocation must be aborted as one batch');
    assert.equal(
      tracker.classifyExecutionId('thread-1', 'codex', 'inv-late'),
      'absent',
      'the non-primary sibling must not remain owned after force replacement',
    );
  });

  it('force mode rejects a foreign tracker owner before routing or clearing its pause state', async () => {
    await app.close();
    deps = buildDeps();
    const { tracker, processor } = wireRealExecutionOwners(deps);
    const foreignController = tracker.startAll('thread-1', ['opus'], 'user-b', 'inv-user-b');
    /** @type {any} */ (processor).pausedSlots.set(OPUS_SLOT_KEY, 'failed');
    /** @type {any} */ (processor).pauseEpoch.set(OPUS_SLOT_KEY, 3);

    const { messagesRoutes } = await import('../dist/routes/messages.js');
    app = Fastify();
    await app.register(messagesRoutes, deps);
    await app.ready();

    const res = await app.inject({
      method: 'POST',
      url: '/api/messages',
      headers: { 'x-cat-cafe-user': 'user-a', 'content-type': 'application/json' },
      payload: { content: '不能抢走别人的猫', threadId: 'thread-1', deliveryMode: 'force' },
    });
    await new Promise((resolve) => setImmediate(resolve));

    assert.equal(res.statusCode, 409);
    assert.equal(JSON.parse(res.body).code, 'INVOCATION_OWNER_CHANGED');
    assert.equal(deps.router.routeExecution.mock.calls.length, 0, 'rejected force request must not route');
    assert.equal(foreignController.signal.aborted, false);
    assert.equal(tracker.getUserId('thread-1', 'opus'), 'user-b');
    assert.equal(tracker.classifyExecutionId('thread-1', 'opus', 'inv-user-b'), 'matching');
    assert.equal(
      /** @type {any} */ (processor).pausedSlots.get(OPUS_SLOT_KEY),
      'failed',
      'foreign pause state must remain untouched',
    );
    assert.equal(/** @type {any} */ (processor).pauseEpoch.get(OPUS_SLOT_KEY), 3);
    const terminalized = deps.invocationRecordStore.update.mock.calls.find(
      (call) => call.arguments[0] === 'inv-stub' && call.arguments[1]?.status === 'canceled',
    );
    assert.ok(terminalized, 'created replacement record must be terminalized before returning 409');
  });

  it('force mode rejects a mixed-user target set before canceling any requester-owned sibling', async () => {
    await app.close();
    deps = buildDeps();
    deps.router.resolveTargetsAndIntent = mock.fn(async () => ({
      targetCats: ['opus', 'codex'],
      intent: { intent: 'execute' },
    }));
    const { tracker, processor } = wireRealExecutionOwners(deps);
    const requesterController = tracker.startAll('thread-1', ['opus'], 'user-a', 'inv-user-a');
    const foreignController = tracker.startAll('thread-1', ['codex'], 'user-b', 'inv-user-b');
    /** @type {any} */ (processor).pausedSlots.set(OPUS_SLOT_KEY, 'failed');
    /** @type {any} */ (processor).pauseEpoch.set(OPUS_SLOT_KEY, 5);
    /** @type {any} */ (processor).pausedSlots.set(CODEX_SLOT_KEY, 'failed');
    /** @type {any} */ (processor).pauseEpoch.set(CODEX_SLOT_KEY, 6);

    const { messagesRoutes } = await import('../dist/routes/messages.js');
    app = Fastify();
    await app.register(messagesRoutes, deps);
    await app.ready();

    const res = await app.inject({
      method: 'POST',
      url: '/api/messages',
      headers: { 'x-cat-cafe-user': 'user-a', 'content-type': 'application/json' },
      payload: { content: '@opus @codex 不允许部分抢占', threadId: 'thread-1', deliveryMode: 'force' },
    });
    await new Promise((resolve) => setImmediate(resolve));

    assert.equal(res.statusCode, 409);
    assert.equal(JSON.parse(res.body).code, 'INVOCATION_OWNER_CHANGED');
    assert.equal(deps.router.routeExecution.mock.calls.length, 0, 'rejected mixed-user force must not route');
    assert.equal(requesterController.signal.aborted, false, 'requester-owned sibling must survive atomic rejection');
    assert.equal(foreignController.signal.aborted, false, 'foreign sibling must survive atomic rejection');
    assert.equal(tracker.classifyExecutionId('thread-1', 'opus', 'inv-user-a'), 'matching');
    assert.equal(tracker.classifyExecutionId('thread-1', 'codex', 'inv-user-b'), 'matching');
    assert.equal(/** @type {any} */ (processor).pausedSlots.get(OPUS_SLOT_KEY), 'failed');
    assert.equal(/** @type {any} */ (processor).pauseEpoch.get(OPUS_SLOT_KEY), 5);
    assert.equal(/** @type {any} */ (processor).pausedSlots.get(CODEX_SLOT_KEY), 'failed');
    assert.equal(/** @type {any} */ (processor).pauseEpoch.get(CODEX_SLOT_KEY), 6);
    const cancelMessages = deps.socketManager.broadcastAgentMessage.mock.calls.filter(
      (call) => call.arguments[0]?.type === 'system_info',
    );
    assert.equal(cancelMessages.length, 0, 'rejected mixed-user force must not broadcast partial cancellation');
  });

  it('force mode rejects a foreign pre-start reservation without routing or partially releasing custody', async () => {
    await app.close();
    deps = buildDeps();
    const foreignCreate = deferred();
    let createCalls = 0;
    deps.invocationRecordStore.create.mock.mockImplementation(async () => {
      createCalls += 1;
      if (createCalls === 1) return foreignCreate.promise;
      return { outcome: 'created', invocationId: 'inv-user-a' };
    });
    const { tracker, processor } = wireRealExecutionOwners(deps);

    deps.invocationQueue.enqueue({
      ownerAuthProvenance: 'unknown',
      threadId: 'thread-1',
      userId: 'user-b',
      content: 'foreign queued execution',
      source: 'user',
      targetCats: ['opus'],
      intent: 'execute',
    });
    assert.equal((await processor.processNext('thread-1', 'user-b')).started, true);
    const foreignReservation = /** @type {any} */ (processor).processingSlots.get(OPUS_SLOT_KEY);
    assert.ok(foreignReservation);
    /** @type {any} */ (processor).pausedSlots.set(OPUS_SLOT_KEY, 'failed');
    /** @type {any} */ (processor).pauseEpoch.set(OPUS_SLOT_KEY, 4);

    const { messagesRoutes } = await import('../dist/routes/messages.js');
    app = Fastify();
    await app.register(messagesRoutes, deps);
    await app.ready();

    const res = await app.inject({
      method: 'POST',
      url: '/api/messages',
      headers: { 'x-cat-cafe-user': 'user-a', 'content-type': 'application/json' },
      payload: { content: '不能抢走排队中的猫', threadId: 'thread-1', deliveryMode: 'force' },
    });
    await new Promise((resolve) => setImmediate(resolve));

    assert.equal(res.statusCode, 409);
    assert.equal(JSON.parse(res.body).code, 'INVOCATION_OWNER_CHANGED');
    assert.equal(deps.router.routeExecution.mock.calls.length, 0, 'rejected force request must not route');
    assert.equal(
      /** @type {any} */ (processor).processingSlots.get(OPUS_SLOT_KEY),
      foreignReservation,
      'foreign reservation must remain the exact slot owner',
    );
    assert.equal(tracker.has('thread-1', 'opus'), false);
    assert.equal(
      /** @type {any} */ (processor).pausedSlots.get(OPUS_SLOT_KEY),
      'failed',
      'foreign pause state must remain untouched',
    );
    assert.equal(/** @type {any} */ (processor).pauseEpoch.get(OPUS_SLOT_KEY), 4);
    const terminalized = deps.invocationRecordStore.update.mock.calls.find(
      (call) => call.arguments[0] === 'inv-user-a' && call.arguments[1]?.status === 'canceled',
    );
    assert.ok(terminalized, 'created replacement record must be terminalized before returning 409');

    foreignCreate.resolve({ outcome: 'created', invocationId: 'inv-user-b' });
  });

  it('non-preemptive immediate mode checks QueueProcessor reservation ownership before tracker start', async () => {
    deps.invocationTracker.has.mock.mockImplementation(() => false);
    const controller = new AbortController();
    deps.queueProcessor.acquireExternalExecution = mock.fn(() => controller);

    const res = await app.inject({
      method: 'POST',
      url: '/api/messages',
      headers: { 'x-cat-cafe-user': 'user-1', 'content-type': 'application/json' },
      payload: { content: '安全直发', threadId: 'thread-1', deliveryMode: 'immediate' },
    });

    assert.equal(res.statusCode, 200);
    assert.equal(deps.queueProcessor.acquireExternalExecution.mock.calls.length, 1);
    assert.deepEqual(deps.queueProcessor.acquireExternalExecution.mock.calls[0].arguments, [
      'thread-1',
      ['opus'],
      'user-1',
      { mode: 'non_preemptive' },
    ]);
  });

  it('immediate mode when no active → normal execution (no queue)', async () => {
    // has() returns false → no active invocation
    deps.invocationTracker.has.mock.mockImplementation(() => false);

    const res = await app.inject({
      method: 'POST',
      url: '/api/messages',
      headers: { 'x-cat-cafe-user': 'user-1', 'content-type': 'application/json' },
      payload: { content: '直接发送', threadId: 'thread-1', deliveryMode: 'immediate' },
    });

    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.body);
    assert.equal(body.status, 'processing');
    assert.match(body.userMessageId, /^msg-/);

    // Should go through normal path
    assert.ok(deps.invocationRecordStore.create.mock.calls.length > 0);

    // Queue should be empty
    assert.equal(deps.invocationQueue.list('thread-1', 'user-1').length, 0);
  });

  it('immediate startup watchdog releases slot when routeExecution never starts provider events', async (t) => {
    t.mock.timers.enable({ apis: ['Date', 'setTimeout', 'setInterval'], now: 0 });
    await app.close();
    deps = buildDeps({ invocationStartupWatchdogMs: 50 });
    const { messagesRoutes } = await import('../dist/routes/messages.js');
    app = Fastify();
    await app.register(messagesRoutes, deps);
    await app.ready();

    deps.invocationTracker.has.mock.mockImplementation(() => false);

    let capturedSignal;
    deps.router.routeExecution.mock.mockImplementation(
      async function* (_userId, _content, _threadId, _messageId, _cats, _intent, options) {
        capturedSignal = options.signal;
        await new Promise(() => {});
      },
    );

    const res = await app.inject({
      method: 'POST',
      url: '/api/messages',
      headers: { 'x-cat-cafe-user': 'user-1', 'content-type': 'application/json' },
      payload: { content: '@opus', threadId: 'thread-1', deliveryMode: 'immediate' },
    });

    assert.equal(res.statusCode, 200);
    assert.equal(JSON.parse(res.body).status, 'processing');

    t.mock.timers.tick(51);
    await Promise.resolve();
    await Promise.resolve();

    assert.equal(capturedSignal?.aborted, true, 'watchdog should abort the stuck invocation');
    assert.equal(capturedSignal?.reason, 'startup_timeout');
    assert.ok(deps.invocationTracker.completeAll.mock.calls.length > 0, 'watchdog should release tracker slot');

    const failedUpdate = deps.invocationRecordStore.update.mock.calls.find(
      (c) => c.arguments[0] === 'inv-stub' && c.arguments[1]?.status === 'failed',
    );
    assert.ok(failedUpdate, 'watchdog should mark the invocation record failed');

    const completion = deps.queueProcessor.onInvocationComplete.mock.calls.find(
      (c) => c.arguments[0] === 'thread-1' && c.arguments[1] === 'opus' && c.arguments[2] === 'failed',
    );
    assert.ok(completion, 'watchdog should notify queue processor so queued work is not stuck');
  });

  it('queue completion watchdog fires when terminal bookkeeping never settles', async (t) => {
    t.mock.timers.enable({ apis: ['Date', 'setTimeout', 'setInterval'], now: 0 });
    await app.close();
    const stuckCommit = deferred();
    deps = buildDeps({
      queueCompletionWatchdogMs: 50,
      sessionContinuationCoordinator: {
        prepareInvocationContext: mock.fn(async ({ content }) => ({ content, sessionPolicy: 'resume' })),
        commitInvocationOutcome: mock.fn(() => stuckCommit.promise),
      },
    });
    const { messagesRoutes } = await import('../dist/routes/messages.js');
    app = Fastify();
    await app.register(messagesRoutes, deps);
    await app.ready();

    const res = await app.inject({
      method: 'POST',
      url: '/api/messages',
      headers: { 'x-cat-cafe-user': 'user-1', 'content-type': 'application/json' },
      payload: { content: '@opus', threadId: 'thread-1', deliveryMode: 'immediate' },
    });
    assert.equal(res.statusCode, 200);

    for (
      let i = 0;
      i < 10 && deps.sessionContinuationCoordinator.commitInvocationOutcome.mock.calls.length === 0;
      i++
    ) {
      await Promise.resolve();
    }
    assert.equal(
      deps.sessionContinuationCoordinator.commitInvocationOutcome.mock.calls.length,
      1,
      'test must reach the real post-completeAll bookkeeping window',
    );
    assert.equal(deps.queueProcessor.onInvocationComplete.mock.calls.length, 0);

    t.mock.timers.tick(51);
    await Promise.resolve();
    await Promise.resolve();

    assert.equal(
      deps.queueProcessor.onInvocationComplete.mock.calls.length,
      1,
      'a stuck terminal write/continuation commit must not permanently suppress queue drain notification',
    );
    assert.deepEqual(deps.queueProcessor.onInvocationComplete.mock.calls[0].arguments.slice(0, 4), [
      'thread-1',
      'opus',
      'succeeded',
      'inv-stub',
    ]);

    stuckCommit.resolve();
    await Promise.resolve();
    await Promise.resolve();
    assert.equal(
      deps.queueProcessor.onInvocationComplete.mock.calls.length,
      1,
      'normal finally must replay the same completion idempotently after the watchdog wins',
    );
  });

  it('default broadcast with queued leftovers but no active invocation → executes immediately', async () => {
    deps.invocationTracker.has.mock.mockImplementation(() => false);
    deps.queueProcessor = {
      isThreadBusy: mock.fn(() => true),
      isCatBusy: mock.fn(() => false),
      onInvocationComplete: mock.fn(async () => {}),
    };
    deps.invocationQueue.enqueue({
      ownerAuthProvenance: 'unknown',
      threadId: 'thread-1',
      userId: 'user-1',
      content: 'queued-leftover',
      source: 'user',
      targetCats: ['opus'],
      intent: 'execute',
    });

    const res = await app.inject({
      method: 'POST',
      url: '/api/messages',
      headers: { 'x-cat-cafe-user': 'user-1', 'content-type': 'application/json' },
      payload: { content: 'new broadcast', threadId: 'thread-1' },
    });

    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.body);
    assert.equal(body.status, 'processing');
    assert.ok(deps.invocationRecordStore.create.mock.calls.length > 0);
    assert.equal(deps.invocationQueue.list('thread-1', 'user-1').length, 1, 'leftover queue must not grow');
  });

  it('TOCTOU degrade-to-queue replay with same idempotencyKey does not append duplicate message', async () => {
    deps.invocationTracker.has.mock.mockImplementation(() => false);
    deps.invocationTracker.tryStartThreadAll.mock.mockImplementation(() => null);

    const first = await app.inject({
      method: 'POST',
      url: '/api/messages',
      headers: { 'x-cat-cafe-user': 'user-1', 'content-type': 'application/json' },
      payload: {
        content: 'TOCTOU replay',
        threadId: 'thread-1',
        deliveryMode: 'immediate',
        idempotencyKey: '22222222-2222-4222-8222-222222222222',
      },
    });
    assert.equal(first.statusCode, 202);
    const firstBody = JSON.parse(first.body);

    const replay = await app.inject({
      method: 'POST',
      url: '/api/messages',
      headers: { 'x-cat-cafe-user': 'user-1', 'content-type': 'application/json' },
      payload: {
        content: 'TOCTOU replay',
        threadId: 'thread-1',
        deliveryMode: 'immediate',
        idempotencyKey: '22222222-2222-4222-8222-222222222222',
      },
    });
    assert.equal(replay.statusCode, 202);
    const replayBody = JSON.parse(replay.body);

    assert.equal(deps.messageStore.append.mock.calls.length, 1, 'replay should not append again');
    assert.equal(deps.invocationQueue.list('thread-1', 'user-1').length, 1, 'replay should not add a new queue row');
    assert.equal(replayBody.entryId, firstBody.entryId, 'replay should point to existing queue entry');
    assert.equal(replayBody.userMessageId, firstBody.userMessageId, 'replay should reuse original user message');
  });

  it('aborted invocation does not emit spawn_started after stop wins the race', async () => {
    const controller = new AbortController();
    let releaseRunningUpdate;
    const runningUpdateGate = new Promise((resolve) => {
      releaseRunningUpdate = resolve;
    });

    deps.invocationTracker.tryStartThreadAll.mock.mockImplementation(() => controller);
    deps.invocationRecordStore.update.mock.mockImplementation(async (_id, data) => {
      if (data?.status === 'running') {
        await runningUpdateGate;
      }
    });
    deps.router.routeExecution.mock.mockImplementation(async function* () {
      yield { type: 'text', catId: 'opus', content: 'late', timestamp: Date.now() };
      yield { type: 'done', catId: 'opus', timestamp: Date.now() };
    });

    const res = await app.inject({
      method: 'POST',
      url: '/api/messages',
      headers: { 'x-cat-cafe-user': 'user-1', 'content-type': 'application/json' },
      payload: { content: '先发再停', threadId: 'thread-1', deliveryMode: 'immediate' },
    });

    assert.equal(res.statusCode, 200);

    controller.abort('user_stop');
    releaseRunningUpdate();
    await new Promise((resolve) => setTimeout(resolve, 20));

    const spawnStarted = deps.socketManager.broadcastToRoom.mock.calls.find((c) => c.arguments[1] === 'spawn_started');
    assert.equal(spawnStarted, undefined);
  });

  it('immediate execution passes queueHasQueuedMessages fairness callback to routeExecution', async () => {
    deps.invocationTracker.has.mock.mockImplementation(() => false);
    deps.invocationQueue.enqueue({
      ownerAuthProvenance: 'unknown',
      threadId: 'thread-1',
      userId: 'user-1',
      content: 'queued-before',
      source: 'user',
      targetCats: ['opus'],
      intent: 'execute',
    });

    const res = await app.inject({
      method: 'POST',
      url: '/api/messages',
      headers: { 'x-cat-cafe-user': 'user-1', 'content-type': 'application/json' },
      payload: { content: '直接发送', threadId: 'thread-1', deliveryMode: 'immediate' },
    });
    assert.equal(res.statusCode, 200);

    await new Promise((r) => setTimeout(r, 20));
    assert.ok(deps.router.routeExecution.mock.calls.length > 0);
    const call = deps.router.routeExecution.mock.calls[0];
    const options = call.arguments[6];
    assert.equal(options?.ownerAuthProvenance, 'strict');
    assert.equal(options?.humanDispositionInvocationOrigin, 'direct_owner');
    assert.equal(typeof options?.queueHasQueuedMessages, 'function');
    assert.equal(options.queueHasQueuedMessages('thread-1'), true);
    assert.equal(options.queueHasQueuedMessages('thread-x'), false);
  });

  it('trusted browser compatibility fallback is carried as non-strict provenance', async () => {
    deps.invocationTracker.has.mock.mockImplementation(() => false);

    const res = await app.inject({
      method: 'POST',
      url: '/api/messages',
      headers: { origin: 'http://localhost:3003', 'content-type': 'application/json' },
      payload: { content: '兼容入口', threadId: 'thread-1', deliveryMode: 'immediate' },
    });
    assert.equal(res.statusCode, 200);

    await new Promise((r) => setTimeout(r, 20));
    const options = deps.router.routeExecution.mock.calls[0].arguments[6];
    assert.equal(options.ownerAuthProvenance, 'compatibility_fallback');
  });

  it('immediate direct execution applies pending continuation before routeExecution', async () => {
    deps.invocationTracker.has.mock.mockImplementation(() => false);
    const capsule = completeCapsuleForSeal(
      buildCapsuleFromRouteState({
        threadId: 'thread-1',
        catId: 'opus',
        mode: 'independent',
        a2aEnabled: true,
      }),
      {
        invocationId: 'inv-pending',
        createdAt: Date.now(),
        seal: { sessionId: 'sess-pending', sessionSeq: 1, reason: 'threshold' },
      },
    );
    const consumedContinuation = { threadId: 'thread-1', catId: 'opus', userId: 'user-1', capsule };
    deps.sessionContinuationCoordinator = {
      prepareInvocationContext: mock.fn(async ({ content }) => ({
        content: `CONTINUATION\n\n${content}`,
        consumedContinuation,
        sessionPolicy: 'resume',
      })),
      commitInvocationOutcome: mock.fn(async () => {}),
    };

    const res = await app.inject({
      method: 'POST',
      url: '/api/messages',
      headers: { 'x-cat-cafe-user': 'user-1', 'content-type': 'application/json' },
      payload: { content: '用户继续', threadId: 'thread-1', deliveryMode: 'immediate' },
    });
    assert.equal(res.statusCode, 200);

    await new Promise((r) => setTimeout(r, 50));

    assert.equal(deps.sessionContinuationCoordinator.prepareInvocationContext.mock.calls.length, 1);
    assert.deepEqual(deps.sessionContinuationCoordinator.prepareInvocationContext.mock.calls[0].arguments[0], {
      threadId: 'thread-1',
      catId: 'opus',
      userId: 'user-1',
      content: '用户继续',
    });
    assert.equal(deps.router.routeExecution.mock.calls[0].arguments[1], 'CONTINUATION\n\n用户继续');

    assert.equal(deps.sessionContinuationCoordinator.commitInvocationOutcome.mock.calls.length, 1);
    const commitInput = deps.sessionContinuationCoordinator.commitInvocationOutcome.mock.calls[0].arguments[0];
    assert.equal(commitInput.finalStatus, 'succeeded');
    assert.equal(commitInput.consumedContinuation, consumedContinuation);
  });

  it('immediate direct execution restores consumed continuation through coordinator on failure', async () => {
    deps.invocationTracker.has.mock.mockImplementation(() => false);
    const capsule = completeCapsuleForSeal(
      buildCapsuleFromRouteState({
        threadId: 'thread-1',
        catId: 'opus',
        mode: 'independent',
        a2aEnabled: true,
      }),
      {
        invocationId: 'inv-pending-fail',
        createdAt: Date.now(),
        seal: { sessionId: 'sess-pending-fail', sessionSeq: 1, reason: 'threshold' },
      },
    );
    const consumedContinuation = { threadId: 'thread-1', catId: 'opus', userId: 'user-1', capsule };
    deps.sessionContinuationCoordinator = {
      prepareInvocationContext: mock.fn(async ({ content }) => ({
        content: `CONTINUATION\n\n${content}`,
        consumedContinuation,
        sessionPolicy: 'resume',
      })),
      commitInvocationOutcome: mock.fn(async () => {}),
    };
    deps.router.routeExecution.mock.mockImplementation(async function* () {
      throw new Error('route failed');
    });

    const res = await app.inject({
      method: 'POST',
      url: '/api/messages',
      headers: { 'x-cat-cafe-user': 'user-1', 'content-type': 'application/json' },
      payload: { content: '用户继续失败', threadId: 'thread-1', deliveryMode: 'immediate' },
    });
    assert.equal(res.statusCode, 200);

    await new Promise((r) => setTimeout(r, 50));

    assert.equal(deps.sessionContinuationCoordinator.commitInvocationOutcome.mock.calls.length, 1);
    const commitInput = deps.sessionContinuationCoordinator.commitInvocationOutcome.mock.calls[0].arguments[0];
    assert.equal(commitInput.finalStatus, 'failed');
    assert.equal(commitInput.consumedContinuation, consumedContinuation);
  });

  it('immediate execution schedules continuation when route emits seal capsule and succeeds', async () => {
    deps.invocationTracker.has.mock.mockImplementation(() => false);
    const capsule = completeCapsuleForSeal(
      buildCapsuleFromRouteState({
        threadId: 'thread-1',
        catId: 'opus',
        mode: 'independent',
        a2aEnabled: true,
      }),
      {
        invocationId: 'inv-seal',
        createdAt: Date.now(),
        seal: { sessionId: 'sess-1', sessionSeq: 1, reason: 'threshold' },
      },
    );
    deps.router.routeExecution.mock.mockImplementation(async function* () {
      yield {
        type: 'system_info',
        catId: 'opus',
        content: JSON.stringify({ type: 'session_seal_requested', continuityCapsule: capsule }),
        timestamp: Date.now(),
      };
      yield { type: 'done', catId: 'opus', timestamp: Date.now() };
    });

    const res = await app.inject({
      method: 'POST',
      url: '/api/messages',
      headers: { 'x-cat-cafe-user': 'user-1', 'content-type': 'application/json' },
      payload: { content: '触发 seal', threadId: 'thread-1', deliveryMode: 'immediate' },
    });
    assert.equal(res.statusCode, 200);

    await new Promise((r) => setTimeout(r, 50));

    assert.equal(deps.queueProcessor.enqueueContinuation.mock.calls.length, 1);
    const call = deps.queueProcessor.enqueueContinuation.mock.calls[0].arguments[0];
    assert.equal(call.threadId, 'thread-1');
    assert.equal(call.userId, 'user-1');
    assert.equal(call.catId, 'opus');
    assert.equal(call.capsule.seal.sessionId, 'sess-1');
    assert.equal(call.ownerAuthProvenance, 'strict');
  });

  it('immediate success persists produced continuation even when it was already queued', async () => {
    deps.invocationTracker.has.mock.mockImplementation(() => false);
    const capsule = completeCapsuleForSeal(
      buildCapsuleFromRouteState({
        threadId: 'thread-1',
        catId: 'opus',
        mode: 'independent',
        a2aEnabled: true,
      }),
      {
        invocationId: 'inv-seal-queued',
        createdAt: Date.now(),
        seal: { sessionId: 'sess-queued', sessionSeq: 1, reason: 'threshold' },
      },
    );
    deps.sessionContinuationCoordinator = {
      prepareInvocationContext: mock.fn(async ({ content }) => ({ content, sessionPolicy: 'resume' })),
      commitInvocationOutcome: mock.fn(async () => {}),
    };
    deps.router.routeExecution.mock.mockImplementation(async function* () {
      yield {
        type: 'system_info',
        catId: 'opus',
        content: JSON.stringify({ type: 'session_seal_requested', continuityCapsule: capsule }),
        timestamp: Date.now(),
      };
      yield { type: 'done', catId: 'opus', timestamp: Date.now() };
    });

    const res = await app.inject({
      method: 'POST',
      url: '/api/messages',
      headers: { 'x-cat-cafe-user': 'user-1', 'content-type': 'application/json' },
      payload: { content: '触发 seal 并排队', threadId: 'thread-1', deliveryMode: 'immediate' },
    });
    assert.equal(res.statusCode, 200);

    await new Promise((r) => setTimeout(r, 50));

    assert.equal(deps.queueProcessor.enqueueContinuation.mock.calls.length, 1);
    assert.equal(deps.sessionContinuationCoordinator.commitInvocationOutcome.mock.calls.length, 1);
    const commitInput = deps.sessionContinuationCoordinator.commitInvocationOutcome.mock.calls[0].arguments[0];
    assert.equal(commitInput.finalStatus, 'succeeded');
    assert.deepEqual(Array.from(commitInput.producedCapsules ?? []), [capsule]);
  });

  it('immediate success does not auto-enqueue produced continuation for reborn sessions', async () => {
    deps.invocationTracker.has.mock.mockImplementation(() => false);
    const capsule = completeCapsuleForSeal(
      buildCapsuleFromRouteState({
        threadId: 'thread-1',
        catId: 'opus',
        mode: 'independent',
        a2aEnabled: true,
      }),
      {
        invocationId: 'inv-reborn-seal',
        createdAt: Date.now(),
        seal: { sessionId: 'sess-reborn', sessionSeq: 1, reason: 'threshold' },
      },
    );
    deps.sessionContinuationCoordinator = {
      prepareInvocationContext: mock.fn(async ({ content }) => ({ content, sessionPolicy: 'reborn' })),
      resolveSessionStrategy: mock.fn(async () => 'reborn'),
      commitInvocationOutcome: mock.fn(async () => {}),
    };
    deps.router.routeExecution.mock.mockImplementation(async function* () {
      yield {
        type: 'system_info',
        catId: 'opus',
        content: JSON.stringify({ type: 'session_seal_requested', continuityCapsule: capsule }),
        timestamp: Date.now(),
      };
      yield { type: 'done', catId: 'opus', timestamp: Date.now() };
    });

    const res = await app.inject({
      method: 'POST',
      url: '/api/messages',
      headers: { 'x-cat-cafe-user': 'user-1', 'content-type': 'application/json' },
      payload: { content: '触发 reborn seal', threadId: 'thread-1', deliveryMode: 'immediate' },
    });
    assert.equal(res.statusCode, 200);

    await new Promise((r) => setTimeout(r, 50));

    assert.deepEqual(deps.sessionContinuationCoordinator.resolveSessionStrategy.mock.calls[0].arguments, [
      'thread-1',
      'opus',
      'user-1',
    ]);
    assert.equal(deps.queueProcessor.enqueueContinuation.mock.calls.length, 0);
    assert.equal(deps.sessionContinuationCoordinator.commitInvocationOutcome.mock.calls.length, 1);
    const commitInput = deps.sessionContinuationCoordinator.commitInvocationOutcome.mock.calls[0].arguments[0];
    assert.equal(commitInput.finalStatus, 'succeeded');
    assert.deepEqual(Array.from(commitInput.producedCapsules ?? []), [capsule]);
  });

  it('immediate multi-cat execution schedules continuation for the capsule owner cat', async () => {
    deps.invocationTracker.has.mock.mockImplementation(() => false);
    deps.router.resolveTargetsAndIntent.mock.mockImplementation(async () => ({
      targetCats: ['opus', 'codex'],
      intent: { intent: 'execute' },
    }));
    const capsule = completeCapsuleForSeal(
      buildCapsuleFromRouteState({
        threadId: 'thread-1',
        catId: 'codex',
        mode: 'parallel',
        a2aEnabled: true,
      }),
      {
        invocationId: 'inv-codex-seal',
        createdAt: Date.now(),
        seal: { sessionId: 'sess-codex', sessionSeq: 1, reason: 'threshold' },
      },
    );
    deps.router.routeExecution.mock.mockImplementation(async function* () {
      yield {
        type: 'system_info',
        catId: 'codex',
        content: JSON.stringify({ type: 'session_seal_requested', continuityCapsule: capsule }),
        timestamp: Date.now(),
      };
      yield { type: 'done', catId: 'codex', timestamp: Date.now() };
    });

    const res = await app.inject({
      method: 'POST',
      url: '/api/messages',
      headers: { 'x-cat-cafe-user': 'user-1', 'content-type': 'application/json' },
      payload: { content: '触发 codex seal', threadId: 'thread-1', deliveryMode: 'immediate' },
    });
    assert.equal(res.statusCode, 200);

    await new Promise((r) => setTimeout(r, 50));

    assert.equal(deps.queueProcessor.enqueueContinuation.mock.calls.length, 1);
    const call = deps.queueProcessor.enqueueContinuation.mock.calls[0].arguments[0];
    assert.equal(call.threadId, 'thread-1');
    assert.equal(call.userId, 'user-1');
    assert.equal(call.catId, 'codex');
    assert.equal(call.capsule.seal.sessionId, 'sess-codex');
  });

  it('immediate multi-cat execution notifies queue completion with every target cat', async () => {
    deps.invocationTracker.has.mock.mockImplementation(() => false);
    deps.router.resolveTargetsAndIntent.mock.mockImplementation(async () => ({
      targetCats: ['opus', 'codex'],
      intent: { intent: 'execute' },
    }));
    deps.router.routeExecution.mock.mockImplementation(async function* () {
      yield { type: 'done', catId: 'opus', timestamp: Date.now() };
      yield { type: 'done', catId: 'codex', timestamp: Date.now() };
    });

    const res = await app.inject({
      method: 'POST',
      url: '/api/messages',
      headers: { 'x-cat-cafe-user': 'user-1', 'content-type': 'application/json' },
      payload: { content: '@opus @codex handle queued bodies', threadId: 'thread-1', deliveryMode: 'immediate' },
    });
    assert.equal(res.statusCode, 200);

    await new Promise((r) => setTimeout(r, 50));

    const completion = deps.queueProcessor.onInvocationComplete.mock.calls.find(
      (c) => c.arguments[0] === 'thread-1' && c.arguments[1] === 'opus' && c.arguments[2] === 'succeeded',
    );
    assert.ok(completion, 'expected queue completion notification');
    assert.equal(completion.arguments[3], 'inv-stub');
    assert.deepEqual(
      completion.arguments[4],
      ['opus', 'codex'],
      'queue completion must include all target cats so secondary queued_seen markers can close',
    );
  });

  it('immediate multi-cat execution notifies queue completion only for cats with done evidence', async () => {
    deps.invocationTracker.has.mock.mockImplementation(() => false);
    deps.invocationTracker.resolveFinalStatus = mock.fn(() => 'succeeded');
    deps.router.resolveTargetsAndIntent.mock.mockImplementation(async () => ({
      targetCats: ['opus', 'codex'],
      intent: { intent: 'execute' },
    }));
    deps.router.routeExecution.mock.mockImplementation(async function* () {
      yield { type: 'done', catId: 'opus', timestamp: Date.now() };
    });

    const res = await app.inject({
      method: 'POST',
      url: '/api/messages',
      headers: { 'x-cat-cafe-user': 'user-1', 'content-type': 'application/json' },
      payload: { content: '@opus @codex codex gets canceled', threadId: 'thread-1', deliveryMode: 'immediate' },
    });
    assert.equal(res.statusCode, 200);

    await new Promise((r) => setTimeout(r, 50));

    const completion = deps.queueProcessor.onInvocationComplete.mock.calls.find(
      (c) => c.arguments[0] === 'thread-1' && c.arguments[1] === 'opus' && c.arguments[2] === 'succeeded',
    );
    assert.ok(completion, 'expected queue completion notification');
    assert.equal(completion.arguments[3], 'inv-stub');
    assert.deepEqual(completion.arguments[4], ['opus']);
    const succeededUpdate = deps.invocationRecordStore.update.mock.calls.find(
      (c) => c.arguments[0] === 'inv-stub' && c.arguments[1]?.status === 'succeeded',
    );
    assert.ok(succeededUpdate, 'expected durable succeeded update');
    assert.deepEqual(
      succeededUpdate.arguments[1].successfulCatIds,
      ['opus'],
      'the durable parent record must carry the same exact per-target success evidence',
    );
  });

  it('preserves partial success when another targeted cat ends with a terminal error', async () => {
    deps.invocationTracker.has.mock.mockImplementation(() => false);
    deps.invocationTracker.resolveFinalStatus = mock.fn(() => 'succeeded');
    deps.router.resolveTargetsAndIntent.mock.mockImplementation(async () => ({
      targetCats: ['opus', 'codex'],
      intent: { intent: 'execute' },
    }));
    deps.router.routeExecution.mock.mockImplementation(async function* () {
      yield { type: 'done', catId: 'opus', timestamp: Date.now() };
      yield {
        type: 'error',
        catId: 'codex',
        error: 'codex terminal failure',
        errorDisposition: 'terminal',
        timestamp: Date.now(),
      };
    });

    const res = await app.inject({
      method: 'POST',
      url: '/api/messages',
      headers: { 'x-cat-cafe-user': 'user-1', 'content-type': 'application/json' },
      payload: { content: '@opus @codex preserve partial success', threadId: 'thread-1', deliveryMode: 'immediate' },
    });
    assert.equal(res.statusCode, 200);

    await new Promise((resolve) => setTimeout(resolve, 50));

    const terminalWrites = deps.invocationRecordStore.update.mock.calls.filter(
      (call) => call.arguments[0] === 'inv-stub' && ['failed', 'succeeded'].includes(call.arguments[1]?.status),
    );
    assert.deepEqual(
      terminalWrites.map((call) => call.arguments[1]),
      [{ status: 'succeeded', successfulCatIds: ['opus'] }],
    );
    const completion = deps.queueProcessor.onInvocationComplete.mock.calls.find(
      (call) => call.arguments[0] === 'thread-1' && call.arguments[1] === 'opus',
    );
    assert.equal(completion?.arguments[2], 'succeeded');
    assert.deepEqual(completion?.arguments[4], ['opus']);
  });

  it('targeted terminal error persists the primary failure instead of succeeded with an empty witness', async () => {
    deps.invocationTracker.has.mock.mockImplementation(() => false);
    deps.router.routeExecution.mock.mockImplementation(async function* () {
      yield {
        type: 'error',
        catId: 'opus',
        error: 'authoritative_compaction_unsupported:hook_authentication_unavailable',
        errorDisposition: 'terminal',
        timestamp: Date.now(),
      };
    });

    const res = await app.inject({
      method: 'POST',
      url: '/api/messages',
      headers: { 'x-cat-cafe-user': 'user-1', 'content-type': 'application/json' },
      payload: { content: '@opus compact safely', threadId: 'thread-1', deliveryMode: 'immediate' },
    });
    assert.equal(res.statusCode, 200);

    await new Promise((resolve) => setTimeout(resolve, 50));

    const terminalWrites = deps.invocationRecordStore.update.mock.calls.filter(
      (call) => call.arguments[0] === 'inv-stub' && ['failed', 'succeeded'].includes(call.arguments[1]?.status),
    );
    assert.deepEqual(
      terminalWrites.map((call) => call.arguments[1]),
      [
        {
          status: 'failed',
          error: 'authoritative_compaction_unsupported:hook_authentication_unavailable',
        },
      ],
    );
    const completion = deps.queueProcessor.onInvocationComplete.mock.calls.find(
      (call) => call.arguments[0] === 'thread-1' && call.arguments[1] === 'opus',
    );
    assert.equal(completion?.arguments[2], 'failed');
    assert.deepEqual(completion?.arguments[4], []);
  });

  it('immediate multi-cat execution schedules continuation for every sealed cat', async () => {
    deps.invocationTracker.has.mock.mockImplementation(() => false);
    deps.router.resolveTargetsAndIntent.mock.mockImplementation(async () => ({
      targetCats: ['opus', 'codex'],
      intent: { intent: 'execute' },
    }));
    const opusCapsule = completeCapsuleForSeal(
      buildCapsuleFromRouteState({
        threadId: 'thread-1',
        catId: 'opus',
        mode: 'parallel',
        a2aEnabled: true,
      }),
      {
        invocationId: 'inv-opus-seal',
        createdAt: Date.now(),
        seal: { sessionId: 'sess-opus', sessionSeq: 1, reason: 'threshold' },
      },
    );
    const codexCapsule = completeCapsuleForSeal(
      buildCapsuleFromRouteState({
        threadId: 'thread-1',
        catId: 'codex',
        mode: 'parallel',
        a2aEnabled: true,
      }),
      {
        invocationId: 'inv-codex-seal',
        createdAt: Date.now(),
        seal: { sessionId: 'sess-codex', sessionSeq: 1, reason: 'threshold' },
      },
    );
    deps.router.routeExecution.mock.mockImplementation(async function* () {
      yield {
        type: 'system_info',
        catId: 'opus',
        content: JSON.stringify({ type: 'session_seal_requested', continuityCapsule: opusCapsule }),
        timestamp: Date.now(),
      };
      yield {
        type: 'system_info',
        catId: 'codex',
        content: JSON.stringify({ type: 'session_seal_requested', continuityCapsule: codexCapsule }),
        timestamp: Date.now(),
      };
      yield { type: 'done', catId: 'opus', timestamp: Date.now() };
      yield { type: 'done', catId: 'codex', timestamp: Date.now() };
    });

    const res = await app.inject({
      method: 'POST',
      url: '/api/messages',
      headers: { 'x-cat-cafe-user': 'user-1', 'content-type': 'application/json' },
      payload: { content: '触发多猫 seal', threadId: 'thread-1', deliveryMode: 'immediate' },
    });
    assert.equal(res.statusCode, 200);

    await new Promise((r) => setTimeout(r, 50));

    assert.equal(deps.queueProcessor.enqueueContinuation.mock.calls.length, 2);
    const calls = deps.queueProcessor.enqueueContinuation.mock.calls
      .map((call) => call.arguments[0])
      .sort((a, b) => a.catId.localeCompare(b.catId));
    assert.equal(calls[0].catId, 'codex');
    assert.equal(calls[0].capsule.seal.sessionId, 'sess-codex');
    assert.equal(calls[1].catId, 'opus');
    assert.equal(calls[1].capsule.seal.sessionId, 'sess-opus');
  });

  // ── P1-1: multipart deliveryMode extraction ──

  it('multipart request with deliveryMode=force → cancels and executes immediately', async () => {
    deps.invocationTracker.has.mock.mockImplementation(() => true);

    const boundary = '----cat-cafe-test-boundary';
    const payload = Buffer.concat([
      Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="content"\r\n\r\n强制发送\r\n`),
      Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="threadId"\r\n\r\nthread-1\r\n`),
      Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="deliveryMode"\r\n\r\nforce\r\n`),
      Buffer.from(`--${boundary}--\r\n`),
    ]);

    const _res = await app.inject({
      method: 'POST',
      url: '/api/messages',
      headers: {
        'content-type': `multipart/form-data; boundary=${boundary}`,
        'x-cat-cafe-user': 'user-1',
      },
      payload,
    });

    // Should cancel active invocation (force mode)
    assert.ok(
      deps.invocationTracker.cancelInvocation.mock.calls.length > 0,
      'multipart deliveryMode=force should cancelInvocation (scoped preempt) the active invocation',
    );

    // Should NOT queue — should proceed to immediate execution
    assert.equal(deps.invocationQueue.list('thread-1', 'user-1').length, 0, 'force mode should not enqueue');
  });

  // ── P1-2: merged entry rollback race ──

  it('enqueued entry rollback preserves merged content when messageStore fails', async () => {
    deps.invocationTracker.has.mock.mockImplementation(() => true);

    // Make messageStore.append fail on FIRST call but simulate merge during the await
    let callCount = 0;
    deps.messageStore.append.mock.mockImplementation(async (msg) => {
      callCount++;
      if (callCount === 1) {
        // Simulate concurrent request B merging into A's entry during A's await
        // B arrives while A is waiting for messageStore.append
        deps.invocationQueue.enqueue({
          ownerAuthProvenance: 'unknown',
          threadId: 'thread-1',
          userId: 'user-1',
          content: 'B的消息不应该丢失',
          source: 'user',
          targetCats: ['opus'],
          intent: 'execute',
        });
        throw new Error('DB write failed for A');
      }
      return { id: `msg-${Date.now()}`, ...msg };
    });

    const res = await app.inject({
      method: 'POST',
      url: '/api/messages',
      headers: { 'x-cat-cafe-user': 'user-1', 'content-type': 'application/json' },
      payload: { content: 'A的消息', threadId: 'thread-1', deliveryMode: 'queue' },
    });

    // A's request failed
    assert.equal(res.statusCode, 500);

    // B's merged content should still be in the queue (not removed by A's rollback)
    const queue = deps.invocationQueue.list('thread-1', 'user-1');
    assert.ok(queue.length > 0, 'queue should not be empty — B merged content must survive');
    assert.ok(queue[0].content.includes('B的消息不应该丢失'), 'B message content should survive A rollback');
  });

  // ── P1 bugfix: abort mid-loop → must NOT ack or mark succeeded ──

  it('bugfix: signal aborted mid-loop → should NOT ack cursors or mark succeeded', async () => {
    // Create a controllable AbortController
    const controller = new AbortController();

    deps.invocationTracker.has.mock.mockImplementation(() => false);
    deps.invocationTracker.start.mock.mockImplementation(() => controller);
    deps.invocationTracker.startAll.mock.mockImplementation(() => controller);
    deps.invocationTracker.tryStartThread.mock.mockImplementation(() => controller);
    deps.invocationTracker.tryStartThreadAll.mock.mockImplementation(() => controller);

    // Router that yields one message, then aborts (simulating external force-cancel),
    // then ends normally (no throw) — this is the exact scenario砚砚 identified.
    deps.router.routeExecution.mock.mockImplementation(async function* () {
      yield { type: 'text', catId: 'opus', content: 'partial output', timestamp: Date.now() };
      // External cancel happens here (e.g., force-send fromco-creator)
      controller.abort();
      // Generator ends normally — no throw. The for-await break exits the loop,
      // but post-loop code must NOT run ack+succeeded.
    });

    const res = await app.inject({
      method: 'POST',
      url: '/api/messages',
      headers: { 'x-cat-cafe-user': 'user-1', 'content-type': 'application/json' },
      payload: { content: '测试取消', threadId: 'thread-1' },
    });

    assert.equal(res.statusCode, 200);

    // Wait for background IIFE to complete
    await new Promise((resolve) => setTimeout(resolve, 200));

    // ackCollectedCursors should NOT be called (aborted invocation)
    assert.equal(deps.router.ackCollectedCursors.mock.calls.length, 0, 'should NOT ack cursors for aborted invocation');

    // invocationRecordStore.update should have 'canceled', NOT 'succeeded'
    const updateCalls = deps.invocationRecordStore.update.mock.calls;
    const succeededCall = updateCalls.find((c) => c.arguments[1]?.status === 'succeeded');
    assert.ok(!succeededCall, 'should NOT mark as succeeded when signal aborted');

    const canceledCall = updateCalls.find((c) => c.arguments[1]?.status === 'canceled');
    assert.ok(canceledCall, 'should mark as canceled when signal aborted');
  });

  it('F148 fix: abort after partial completion still acks collected cursors', async () => {
    const controller = new AbortController();

    deps.invocationTracker.has.mock.mockImplementation(() => false);
    deps.invocationTracker.start.mock.mockImplementation(() => controller);
    deps.invocationTracker.startAll.mock.mockImplementation(() => controller);
    deps.invocationTracker.tryStartThread.mock.mockImplementation(() => controller);
    deps.invocationTracker.tryStartThreadAll.mock.mockImplementation(() => controller);
    deps.router.resolveTargetsAndIntent.mock.mockImplementation(async () => ({
      targetCats: ['gemini', 'opus'],
      intent: { intent: 'execute' },
    }));
    deps.router.routeExecution.mock.mockImplementation(
      async function* (_userId, _content, _threadId, _messageId, _targetCats, _intent, opts) {
        opts.cursorBoundaries.set('gemini', 'boundary-gemini-001');
        yield { type: 'text', catId: 'gemini', content: 'done', timestamp: Date.now() };
        yield { type: 'done', catId: 'gemini', timestamp: Date.now() };
        controller.abort('preempted');
        yield { type: 'text', catId: 'opus', content: 'partial', timestamp: Date.now() };
      },
    );

    const res = await app.inject({
      method: 'POST',
      url: '/api/messages',
      headers: { 'x-cat-cafe-user': 'user-1', 'content-type': 'application/json' },
      payload: { content: '@gemini @opus 测试取消后补 ack', threadId: 'thread-1' },
    });

    assert.equal(res.statusCode, 200);

    await new Promise((resolve) => setTimeout(resolve, 200));

    const ackCalls = deps.router.ackCollectedCursors.mock.calls;
    assert.equal(ackCalls.length, 1, 'should ack collected cursors for completed cats before abort');
    assert.equal(ackCalls[0].arguments[0], 'user-1');
    assert.equal(ackCalls[0].arguments[1], 'thread-1');
    const boundaries = ackCalls[0].arguments[2];
    assert.ok(boundaries instanceof Map, 'boundaries should be a Map');
    assert.equal(boundaries.get('gemini'), 'boundary-gemini-001');

    const updateCalls = deps.invocationRecordStore.update.mock.calls;
    const succeededCall = updateCalls.find((c) => c.arguments[1]?.status === 'succeeded');
    assert.ok(!succeededCall, 'should NOT mark as succeeded when signal aborted');
    const canceledCall = updateCalls.find((c) => c.arguments[1]?.status === 'canceled');
    assert.ok(canceledCall, 'should mark as canceled when signal aborted');
  });

  it('F148 fix: exception after partial completion still acks collected cursors', async () => {
    deps.router.resolveTargetsAndIntent.mock.mockImplementation(async () => ({
      targetCats: ['gemini', 'opus'],
      intent: { intent: 'execute' },
    }));
    deps.router.routeExecution.mock.mockImplementation(
      async function* (_userId, _content, _threadId, _messageId, _targetCats, _intent, opts) {
        opts.cursorBoundaries.set('gemini', 'boundary-gemini-002');
        yield { type: 'text', catId: 'gemini', content: 'done', timestamp: Date.now() };
        yield { type: 'done', catId: 'gemini', timestamp: Date.now() };
        throw new Error('ACP process crashed');
      },
    );

    const res = await app.inject({
      method: 'POST',
      url: '/api/messages',
      headers: { 'x-cat-cafe-user': 'user-1', 'content-type': 'application/json' },
      payload: { content: '@gemini @opus 测试异常后补 ack', threadId: 'thread-1' },
    });

    assert.equal(res.statusCode, 200);

    await new Promise((resolve) => setTimeout(resolve, 200));

    const ackCalls = deps.router.ackCollectedCursors.mock.calls;
    assert.equal(ackCalls.length, 1, 'should ack collected cursors before failing the invocation');
    const boundaries = ackCalls[0].arguments[2];
    assert.ok(boundaries instanceof Map, 'boundaries should be a Map');
    assert.equal(boundaries.get('gemini'), 'boundary-gemini-002');

    const updateCalls = deps.invocationRecordStore.update.mock.calls;
    const failedCall = updateCalls.find((c) => c.arguments[1]?.status === 'failed');
    assert.ok(failedCall, 'should mark invocation as failed on exception');
  });

  it('default mode with active invocation → falls back to queue', async () => {
    deps.invocationTracker.has.mock.mockImplementation(() => true);

    // No deliveryMode specified → smart default
    const res = await app.inject({
      method: 'POST',
      url: '/api/messages',
      headers: { 'x-cat-cafe-user': 'user-1', 'content-type': 'application/json' },
      payload: { content: '自动排队', threadId: 'thread-1' },
    });

    assert.equal(res.statusCode, 202);
    const body = JSON.parse(res.body);
    assert.equal(body.status, 'queued');

    // Should NOT have created InvocationRecord
    assert.equal(deps.invocationRecordStore.create.mock.calls.length, 0);
  });
});

describe('POST /api/messages magic word instrumentation (F227 砚砚 P1 — detect→callback→messageId)', () => {
  let app;
  let deps;
  let magicWordCalls;

  beforeEach(async () => {
    magicWordCalls = [];
    deps = buildDeps({
      onMagicWordDetected: (hits, threadId, catId, messageId, ownerUserId, messageExcerpt) => {
        magicWordCalls.push({ hits, threadId, catId, messageId, ownerUserId, messageExcerpt });
      },
    });
    const { messagesRoutes } = await import('../dist/routes/messages.js');
    app = Fastify();
    await app.register(messagesRoutes, deps);
    await app.ready();
  });

  afterEach(async () => {
    if (app) await app.close();
  });

  it('fires onMagicWordDetected with the PERSISTED messageId (not guessed)', async () => {
    deps.invocationTracker.has.mock.mockImplementation(() => true); // queue path

    const res = await app.inject({
      method: 'POST',
      url: '/api/messages',
      headers: { 'x-cat-cafe-user': 'user-1', 'content-type': 'application/json' },
      payload: { content: '这个方案是脚手架，得重写', threadId: 'thread-1', deliveryMode: 'queue' },
    });
    assert.equal(res.statusCode, 202);
    const persistedMessageId = JSON.parse(res.body).userMessageId;

    // tryDetectMagicWords is fire-and-forget (async dynamic import) — let it settle.
    await new Promise((r) => setTimeout(r, 80));

    assert.equal(magicWordCalls.length, 1, 'callback should fire exactly once');
    const call = magicWordCalls[0];
    assert.equal(call.hits[0].word, '脚手架');
    assert.equal(call.threadId, 'thread-1');
    // The whole point of the instrumentation-gap fix: messageId === persisted user message id
    assert.equal(call.messageId, persistedMessageId);
    assert.equal(call.ownerUserId, 'user-1', 'F227 P1: owner = the authenticated sender (queued path)');
    assert.ok(call.messageExcerpt?.includes('脚手架'), 'excerpt carries 原话 context');
  });

  it('does not fire the callback when the message has no magic word', async () => {
    deps.invocationTracker.has.mock.mockImplementation(() => true);

    const res = await app.inject({
      method: 'POST',
      url: '/api/messages',
      headers: { 'x-cat-cafe-user': 'user-1', 'content-type': 'application/json' },
      payload: { content: '普通消息，没有触发词', threadId: 'thread-1', deliveryMode: 'queue' },
    });
    assert.equal(res.statusCode, 202);
    await new Promise((r) => setTimeout(r, 80));
    assert.equal(magicWordCalls.length, 0);
  });

  it('fires on the IMMEDIATE path too with the persisted messageId (砚砚 R2 P1: both paths)', async () => {
    deps.invocationTracker.has.mock.mockImplementation(() => false); // immediate path (no active invocation)

    const res = await app.inject({
      method: 'POST',
      url: '/api/messages',
      headers: { 'x-cat-cafe-user': 'user-1', 'content-type': 'application/json' },
      payload: { content: '这个直接重写吧，脚手架', threadId: 'thread-1', deliveryMode: 'immediate' },
    });
    assert.equal(res.statusCode, 200);
    const persistedMessageId = JSON.parse(res.body).userMessageId;

    await new Promise((r) => setTimeout(r, 80));

    assert.equal(magicWordCalls.length, 1, 'immediate path should also fire the callback');
    assert.equal(magicWordCalls[0].hits[0].word, '脚手架');
    assert.equal(magicWordCalls[0].messageId, persistedMessageId);
    assert.equal(magicWordCalls[0].ownerUserId, 'user-1', 'F227 P1: owner = the authenticated sender (immediate path)');
  });
});
