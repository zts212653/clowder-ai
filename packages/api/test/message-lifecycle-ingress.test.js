import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it, mock } from 'node:test';
import Fastify from 'fastify';
import './helpers/setup-cat-registry.js';

const { InvocationQueue } = await import('../dist/domains/cats/services/agents/invocation/InvocationQueue.js');
const { InvocationRegistry } = await import('../dist/domains/cats/services/agents/invocation/InvocationRegistry.js');
const { messagesRoutes } = await import('../dist/routes/messages.js');
const { sendMessageSchema } = await import('../dist/routes/messages.schema.js');

function createDependencies(overrides = {}) {
  const invocationQueue = new InvocationQueue();
  let messageSequence = 0;
  const messagesByIdempotencyKey = new Map();
  const append = mock.fn(async (message) => ({ id: `message-${++messageSequence}`, ...message }));
  const appendWithQueueLedgerAdmission = mock.fn(async (message, buildAdmission, ledgerStore, maxQueued) => {
    const replay = message.idempotencyKey ? messagesByIdempotencyKey.get(message.idempotencyKey) : null;
    if (replay) {
      const expected = buildAdmission(replay.id);
      const entries = (await Promise.all(expected.map((entry) => ledgerStore.get(entry.threadId, entry.id)))).filter(
        Boolean,
      );
      return { outcome: 'enqueued', message: replay, entries, deduped: true };
    }
    const stored = await append(message);
    const entries = buildAdmission(stored.id);
    const admitted = await ledgerStore.enqueue(entries, maxQueued);
    if (admitted.outcome === 'full') return { outcome: 'full' };
    assert.equal(admitted.outcome, 'enqueued');
    if (message.idempotencyKey) messagesByIdempotencyKey.set(message.idempotencyKey, stored);
    return { outcome: 'enqueued', message: stored, entries: admitted.entries, deduped: false };
  });
  return {
    registry: new InvocationRegistry(),
    invocationQueue,
    messageStore: {
      append,
      appendWithQueueLedgerAdmission,
      getById: mock.fn(async () => null),
      getByThread: mock.fn(async () => []),
      getByThreadBefore: mock.fn(async () => []),
      getByThreadAfter: mock.fn(async () => []),
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
      resolveExplicitTargets: mock.fn(async (cats) => cats),
      routeExecution: mock.fn(async function* () {
        yield { type: 'done', catId: 'opus', timestamp: Date.now() };
      }),
      ackCollectedCursors: mock.fn(async () => {}),
      route: mock.fn(async function* () {
        yield { type: 'done', catId: 'opus', timestamp: Date.now() };
      }),
    },
    invocationTracker: {
      has: mock.fn(() => false),
      tryStartThreadAll: mock.fn(() => new AbortController()),
      startAll: mock.fn(() => new AbortController()),
      completeAll: mock.fn(),
      isDeleting: mock.fn(() => false),
    },
    invocationRecordStore: {
      create: mock.fn(async () => ({ outcome: 'created', invocationId: 'invocation-1' })),
      update: mock.fn(async () => ({})),
      get: mock.fn(async () => null),
    },
    queueProcessor: {
      tryAutoAppendExactEntry: mock.fn(async () => ({ outcome: 'rejected', reason: 'append_unavailable' })),
      requestDrain: mock.fn(async () => {}),
    },
    threadStore: {
      get: mock.fn(async () => ({ id: 'thread-1', createdBy: 'user-1' })),
      updateTitle: mock.fn(async () => {}),
    },
    ...overrides,
  };
}

describe('canonical message lifecycle ingress', () => {
  let app;
  let dependencies;

  beforeEach(async () => {
    dependencies = createDependencies();
    app = Fastify();
    await app.register(messagesRoutes, dependencies);
    await app.ready();
  });

  afterEach(async () => {
    await app?.close();
  });

  it('queues an ordinary idle-thread input instead of invoking the provider directly', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/messages',
      headers: { 'x-cat-cafe-user': 'user-1', 'content-type': 'application/json' },
      payload: { content: 'single ingress', threadId: 'thread-1' },
    });

    assert.equal(response.statusCode, 202, response.body);
    const body = JSON.parse(response.body);
    assert.equal(body.status, 'queued');
    const [entry] = dependencies.invocationQueue.list('thread-1', 'user-1');
    assert.deepEqual(entry.from, { kind: 'user', userId: 'user-1' });
    assert.equal('source' in entry, false, 'Queue sender identity must have one MessageFrom truth');
    const appended = dependencies.messageStore.append.mock.calls[0].arguments[0];
    assert.deepEqual(appended.from, { kind: 'user', userId: 'user-1' });
    assert.equal(appended.provenance?.author, undefined, 'History provenance must not duplicate MessageFrom');
    assert.equal(dependencies.invocationRecordStore.create.mock.calls.length, 0);
    assert.equal(dependencies.router.routeExecution.mock.calls.length, 0);
    assert.equal(dependencies.queueProcessor.requestDrain.mock.calls.length, 1);
  });

  it('offers an explicitly guided exact running target to auto-append', async () => {
    dependencies.invocationTracker.has.mock.mockImplementation(() => true);
    dependencies.invocationTracker.getUserId = mock.fn(() => 'user-1');
    dependencies.invocationTracker.getExecutionId = mock.fn(() => 'parent-1');
    dependencies.router.freshnessCarrierCapability = mock.fn(() => ({
      provider: 'openai_codex',
      carrier: 'codex_app_server',
      deliverySemantics: 'exact_active_turn',
    }));
    dependencies.queueProcessor.tryAutoAppendExactEntry.mock.mockImplementation(async () => ({
      outcome: 'appended',
      entry: null,
      acceptedTargetIds: ['opus'],
    }));

    const response = await app.inject({
      method: 'POST',
      url: '/api/messages',
      headers: { 'x-cat-cafe-user': 'user-1', 'content-type': 'application/json' },
      payload: {
        content: 'append to the current writer',
        threadId: 'thread-1',
        messageDisposition: 'continue_current',
      },
    });

    assert.equal(response.statusCode, 202, response.body);
    const [entry] = dependencies.invocationQueue.list('thread-1', 'user-1');
    assert.deepEqual(entry.delivery.authorIntentByTarget.opus, {
      requested: 'continue_current',
      boundParentInvocationId: 'parent-1',
      carrierCapability: {
        provider: 'openai_codex',
        carrier: 'codex_app_server',
        deliverySemantics: 'exact_active_turn',
      },
    });
    assert.deepEqual(dependencies.queueProcessor.tryAutoAppendExactEntry.mock.calls[0].arguments, [
      { threadId: 'thread-1', userId: 'user-1', entryId: entry.id },
    ]);
  });

  it('auto-appends the admitted source row once and returns every exact target identity', async () => {
    dependencies.router.resolveExplicitTargets.mock.mockImplementation(async (cats) => cats);
    dependencies.invocationTracker.has.mock.mockImplementation(() => true);
    dependencies.invocationTracker.getUserId = mock.fn(() => 'user-1');
    dependencies.invocationTracker.getExecutionId = mock.fn((_threadId, catId) => `parent-${catId}`);
    dependencies.router.freshnessCarrierCapability = mock.fn(() => ({
      provider: 'openai_codex',
      carrier: 'codex_app_server',
      deliverySemantics: 'exact_active_turn',
    }));
    dependencies.queueProcessor.tryAutoAppendExactEntry.mock.mockImplementation(async () => ({
      outcome: 'appended',
      acceptedTargetIds: ['opus', 'codex'],
    }));

    const response = await app.inject({
      method: 'POST',
      url: '/api/messages',
      headers: { 'x-cat-cafe-user': 'user-1', 'content-type': 'application/json' },
      payload: {
        content: 'guide both replies',
        threadId: 'thread-1',
        mentions: ['opus', 'codex'],
        messageDisposition: 'continue_current',
      },
    });

    assert.equal(response.statusCode, 202, response.body);
    const body = response.json();
    assert.equal(body.entries.length, 2);
    assert.deepEqual(
      body.entries.map((entry) => entry.targetCatId),
      ['opus', 'codex'],
    );
    assert.deepEqual(
      dependencies.queueProcessor.tryAutoAppendExactEntry.mock.calls.map((call) => call.arguments[0].entryId),
      [body.entries[0].entryId],
    );
    assert.equal(new Set(body.entries.map((entry) => entry.entryId)).size, 1);
  });

  it('preserves an explicit next-work request without offering it to auto-append', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/messages',
      headers: { 'x-cat-cafe-user': 'user-1', 'content-type': 'application/json' },
      payload: { content: 'do this later', threadId: 'thread-1', messageDisposition: 'next_work' },
    });

    assert.equal(response.statusCode, 202, response.body);
    const [entry] = dependencies.invocationQueue.list('thread-1', 'user-1');
    assert.equal(entry.delivery.authorIntentByTarget.opus.requested, 'next_work');
    assert.equal(dependencies.queueProcessor.tryAutoAppendExactEntry.mock.calls.length, 0);
  });

  it('keeps an ordinary unmentioned input targetless until strict-head admission', async () => {
    dependencies.router.resolveTargetsAndIntent.mock.mockImplementation(async (_content, _threadId, options) => {
      assert.equal(options.allowFallback, false);
      return {
        targetCats: [],
        intent: { intent: 'execute' },
        hasMentions: false,
        routing_warnings: [],
      };
    });

    const response = await app.inject({
      method: 'POST',
      url: '/api/messages',
      headers: { 'x-cat-cafe-user': 'user-1', 'content-type': 'application/json' },
      payload: { content: 'continue without choosing a member yet', threadId: 'thread-1' },
    });

    assert.equal(response.statusCode, 202, response.body);
    const [entry] = dependencies.invocationQueue.list('thread-1', 'user-1');
    assert.deepEqual(entry.targets, []);
    assert.deepEqual(dependencies.messageStore.append.mock.calls[0].arguments[0].mentions, []);
    assert.equal(dependencies.queueProcessor.requestDrain.mock.calls.length, 1);
  });

  it('guides the exact active fallback without rewriting an unmentioned source message', async () => {
    dependencies.router.resolveTargetsAndIntent.mock.mockImplementation(async (_content, _threadId, options) => {
      assert.equal(options.allowFallback, false);
      return {
        targetCats: [],
        intent: { intent: 'execute' },
        hasMentions: false,
        routing_warnings: [],
      };
    });
    dependencies.router.resolveConversationTargetsAtAdmission = mock.fn(async () => ['opus']);
    dependencies.router.freshnessCarrierCapability = mock.fn(() => ({
      provider: 'openai_codex',
      carrier: 'codex_app_server',
      deliverySemantics: 'exact_active_turn',
    }));
    dependencies.invocationTracker.has.mock.mockImplementation(() => true);
    dependencies.invocationTracker.getUserId = mock.fn(() => 'user-1');
    dependencies.invocationTracker.getExecutionId = mock.fn(() => 'parent-1');
    dependencies.queueProcessor.tryAutoAppendExactEntry.mock.mockImplementation(async () => ({
      outcome: 'appended',
      acceptedTargetIds: ['opus'],
    }));
    const participants = [];
    dependencies.threadStore.get.mock.mockImplementation(async () => ({
      id: 'thread-1',
      createdBy: 'user-1',
      participants: [...participants],
    }));
    dependencies.threadStore.addParticipants = mock.fn(async (_threadId, catIds) => {
      for (const catId of catIds) if (!participants.includes(catId)) participants.push(catId);
    });

    const response = await app.inject({
      method: 'POST',
      url: '/api/messages',
      headers: { 'x-cat-cafe-user': 'user-1', 'content-type': 'application/json' },
      payload: {
        content: 'guide whoever is already replying',
        threadId: 'thread-1',
        messageDisposition: 'continue_current',
      },
    });

    assert.equal(response.statusCode, 202, response.body);
    assert.deepEqual(dependencies.router.resolveConversationTargetsAtAdmission.mock.calls[0].arguments, [
      [],
      'thread-1',
    ]);
    const [entry] = dependencies.invocationQueue.list('thread-1', 'user-1');
    assert.deepEqual(entry.targets, ['opus']);
    assert.deepEqual(entry.delivery.authorIntentByTarget.opus, {
      requested: 'continue_current',
      boundParentInvocationId: 'parent-1',
      carrierCapability: {
        provider: 'openai_codex',
        carrier: 'codex_app_server',
        deliverySemantics: 'exact_active_turn',
      },
    });
    assert.deepEqual(dependencies.messageStore.append.mock.calls[0].arguments[0].mentions, []);
    assert.deepEqual(dependencies.threadStore.addParticipants.mock.calls[0].arguments, ['thread-1', ['opus']]);
    assert.deepEqual(dependencies.queueProcessor.tryAutoAppendExactEntry.mock.calls[0].arguments, [
      { threadId: 'thread-1', userId: 'user-1', entryId: entry.id },
    ]);
    assert.deepEqual(response.json().entries, [{ entryId: entry.id, targetCatId: 'opus' }]);
  });

  it('leaves guided targetless work queued when the exact fallback has no current reply', async () => {
    dependencies.router.resolveTargetsAndIntent.mock.mockImplementation(async () => ({
      targetCats: [],
      intent: { intent: 'execute' },
      hasMentions: false,
      routing_warnings: [],
    }));
    dependencies.router.resolveConversationTargetsAtAdmission = mock.fn(async () => ['opus']);
    dependencies.router.freshnessCarrierCapability = mock.fn(() => ({
      provider: 'openai_codex',
      carrier: 'codex_app_server',
      deliverySemantics: 'exact_active_turn',
    }));

    const response = await app.inject({
      method: 'POST',
      url: '/api/messages',
      headers: { 'x-cat-cafe-user': 'user-1', 'content-type': 'application/json' },
      payload: {
        content: 'queue when nobody is replying',
        threadId: 'thread-1',
        messageDisposition: 'continue_current',
      },
    });

    assert.equal(response.statusCode, 202, response.body);
    const [entry] = dependencies.invocationQueue.list('thread-1', 'user-1');
    assert.deepEqual(entry.targets, []);
    assert.deepEqual(response.json().entries, []);
    assert.equal(dependencies.queueProcessor.tryAutoAppendExactEntry.mock.calls.length, 0);
  });

  it('records a truthful queued fallback when the current reply ends before automatic Append', async () => {
    dependencies.invocationTracker.has.mock.mockImplementation(() => true);
    dependencies.invocationTracker.getUserId = mock.fn(() => 'user-1');
    dependencies.invocationTracker.getExecutionId = mock.fn(() => 'parent-1');
    dependencies.router.freshnessCarrierCapability = mock.fn(() => ({
      provider: 'openai_codex',
      carrier: 'codex_app_server',
      deliverySemantics: 'exact_active_turn',
    }));

    const response = await app.inject({
      method: 'POST',
      url: '/api/messages',
      headers: { 'x-cat-cafe-user': 'user-1', 'content-type': 'application/json' },
      payload: {
        content: 'queue if the reply closes at the cutover',
        threadId: 'thread-1',
        mentions: ['opus'],
        messageDisposition: 'continue_current',
      },
    });

    assert.equal(response.statusCode, 202, response.body);
    const [entry] = dependencies.invocationQueue.list('thread-1', 'user-1');
    assert.equal(entry.delivery.authorIntentByTarget.opus.requested, 'continue_current');
    assert.equal(entry.delivery.authorIntentByTarget.opus.boundParentInvocationId, 'parent-1');
    assert.equal(entry.delivery.authorIntentByTarget.opus.fallbackReason, 'parent_terminal_before_exposure');
    assert.equal(typeof entry.delivery.authorIntentByTarget.opus.fallbackAt, 'number');
  });

  it('routes a composer-selected member through the explicit target field without rewriting visible content', async () => {
    dependencies.router.resolveExplicitTargets.mock.mockImplementation(async (cats) => cats);

    const response = await app.inject({
      method: 'POST',
      url: '/api/messages',
      headers: { 'x-cat-cafe-user': 'user-1', 'content-type': 'application/json' },
      payload: { content: '正文里不需要补一个 @ 提及', threadId: 'thread-1', mentions: ['codex'] },
    });

    assert.equal(response.statusCode, 202, response.body);
    assert.equal(dependencies.router.resolveTargetsAndIntent.mock.calls.length, 0);
    assert.deepEqual(dependencies.router.resolveExplicitTargets.mock.calls[0].arguments[0], ['codex']);
    const [entry] = dependencies.invocationQueue.list('thread-1', 'user-1');
    assert.deepEqual(entry.targets, ['codex']);
    assert.equal(entry.payload.content, '正文里不需要补一个 @ 提及');
    assert.deepEqual(dependencies.messageStore.append.mock.calls[0].arguments[0].mentions, ['codex']);
  });

  it('rejects an unavailable composer-selected member instead of silently falling back', async () => {
    dependencies.router.resolveExplicitTargets.mock.mockImplementation(async () => []);

    const response = await app.inject({
      method: 'POST',
      url: '/api/messages',
      headers: { 'x-cat-cafe-user': 'user-1', 'content-type': 'application/json' },
      payload: { content: 'do not reroute this', threadId: 'thread-1', mentions: ['codex'] },
    });

    assert.equal(response.statusCode, 400, response.body);
    assert.equal(JSON.parse(response.body).code, 'INVALID_EXPLICIT_TARGETS');
    assert.equal(dependencies.invocationQueue.list('thread-1', 'user-1').length, 0);
    assert.equal(dependencies.messageStore.append.mock.calls.length, 0);
  });

  it('keeps routing warnings on the canonical Queue/source payload instead of broadcasting a detached notice', async () => {
    const warning = {
      kind: 'cat_not_found',
      mention: '@missing-cat',
      alternatives: [],
    };
    dependencies.router.resolveTargetsAndIntent.mock.mockImplementation(async () => ({
      targetCats: [],
      intent: { intent: 'execute' },
      hasMentions: true,
      routing_warnings: [warning],
    }));

    const response = await app.inject({
      method: 'POST',
      url: '/api/messages',
      headers: { 'x-cat-cafe-user': 'user-1', 'content-type': 'application/json' },
      payload: { content: '@missing-cat please inspect this', threadId: 'thread-1' },
    });

    assert.equal(response.statusCode, 202, response.body);
    const [entry] = dependencies.invocationQueue.list('thread-1', 'user-1');
    assert.deepEqual(entry.payload.routingWarnings, [warning]);
    assert.deepEqual(dependencies.messageStore.append.mock.calls[0].arguments[0].extra.routingWarnings, [warning]);
    assert.equal(dependencies.socketManager.broadcastAgentMessage.mock.calls.length, 0);
  });

  it('does not expose direct immediate or force execution on message creation', () => {
    for (const deliveryMode of ['immediate', 'force']) {
      const result = sendMessageSchema.safeParse({ content: 'no direct path', deliveryMode });
      assert.equal(result.success, false, `${deliveryMode} must not be a message-ingress mode`);
    }
  });

  it('deduplicates replay at the Queue boundary without a second source record', async () => {
    const request = {
      method: 'POST',
      url: '/api/messages',
      headers: { 'x-cat-cafe-user': 'user-1', 'content-type': 'application/json' },
      payload: {
        content: 'same work',
        threadId: 'thread-1',
        idempotencyKey: '11111111-1111-4111-8111-111111111111',
      },
    };

    const first = await app.inject(request);
    const replay = await app.inject(request);

    assert.equal(first.statusCode, 202, first.body);
    assert.equal(replay.statusCode, 202, replay.body);
    assert.equal(JSON.parse(replay.body).entryId, JSON.parse(first.body).entryId);
    assert.equal(dependencies.invocationQueue.list('thread-1', 'user-1').length, 1);
    assert.equal(dependencies.messageStore.append.mock.calls.length, 1);
  });

  it('keeps whisper visibility while routing an idle target through the same Queue', async () => {
    dependencies.router.resolveTargetsAndIntent.mock.mockImplementation(async () => ({
      targetCats: ['codex'],
      intent: { intent: 'execute' },
    }));

    const response = await app.inject({
      method: 'POST',
      url: '/api/messages',
      headers: { 'x-cat-cafe-user': 'user-1', 'content-type': 'application/json' },
      payload: {
        content: 'private input',
        threadId: 'thread-1',
        visibility: 'whisper',
        whisperTo: ['codex'],
      },
    });

    assert.equal(response.statusCode, 202, response.body);
    assert.deepEqual(dependencies.invocationQueue.list('thread-1', 'user-1')[0].targets, ['codex']);
    assert.deepEqual(dependencies.messageStore.append.mock.calls[0].arguments[0].whisperTo, ['codex']);
    assert.equal(dependencies.router.routeExecution.mock.calls.length, 0);
  });

  it('keeps an all-idle multi-target input in one source Queue row', async () => {
    dependencies.router.resolveTargetsAndIntent.mock.mockImplementation(async () => ({
      targetCats: ['opus', 'codex'],
      intent: { intent: 'execute' },
      hasMentions: true,
    }));

    const response = await app.inject({
      method: 'POST',
      url: '/api/messages',
      headers: { 'x-cat-cafe-user': 'user-1', 'content-type': 'application/json' },
      payload: { content: '@opus @codex inspect', threadId: 'thread-1' },
    });

    assert.equal(response.statusCode, 202, response.body);
    const entries = dependencies.invocationQueue.list('thread-1', 'user-1');
    assert.equal(entries.length, 1);
    assert.deepEqual(entries[0].targets.toSorted(), ['codex', 'opus']);
    assert.ok(entries.every((entry) => entry.payload.messageId === entries[0].payload.messageId));
    assert.equal(dependencies.invocationRecordStore.create.mock.calls.length, 0);
  });

  it('admits a refs-only Message Bundle into the same Queue ingress', async () => {
    const sourceMessage = {
      id: 'source-message-1',
      threadId: 'source-thread',
      userId: 'user-1',
      from: { kind: 'agent', catId: 'opus' },
      catId: 'opus',
      content: 'private source body',
      mentions: [],
      timestamp: 1000,
    };
    dependencies.messageStore.getById.mock.mockImplementation(async (messageId) =>
      messageId === sourceMessage.id ? sourceMessage : null,
    );
    dependencies.messageStore.getByThreadAfter.mock.mockImplementation(async (threadId) =>
      threadId === sourceMessage.threadId ? [sourceMessage] : [],
    );
    dependencies.threadStore.get.mock.mockImplementation(async (threadId) => ({
      id: threadId,
      title: threadId === 'source-thread' ? 'Source Thread' : 'Target Thread',
      createdBy: 'user-1',
      participants: [],
    }));

    const response = await app.inject({
      method: 'POST',
      url: '/api/messages',
      headers: { 'x-cat-cafe-user': 'user-1', 'content-type': 'application/json' },
      payload: {
        content: '',
        threadId: 'thread-1',
        messageBundle: {
          sourceThreadId: 'source-thread',
          note: 'focus on the decision',
          items: [{ kind: 'message', messageId: sourceMessage.id }],
          targetCats: ['opus'],
        },
      },
    });

    assert.equal(response.statusCode, 202, response.body);
    assert.equal(dependencies.router.resolveTargetsAndIntent.mock.calls.length, 0);
    assert.deepEqual(dependencies.router.resolveExplicitTargets.mock.calls[0].arguments[0], ['opus']);
    const stored = dependencies.messageStore.append.mock.calls[0].arguments[0];
    assert.deepEqual(stored.extra.messageBundle.items, [{ kind: 'message', messageId: sourceMessage.id }]);
    assert.equal(stored.content.includes(sourceMessage.content), false);
    assert.equal(dependencies.router.routeExecution.mock.calls.length, 0);
  });

  it('detects magic words against the durable Queue source identity', async () => {
    await app.close();
    const detected = [];
    dependencies = createDependencies({
      onMagicWordDetected: (hits, threadId, catId, messageId, ownerUserId) => {
        detected.push({ hits, threadId, catId, messageId, ownerUserId });
      },
    });
    app = Fastify();
    await app.register(messagesRoutes, dependencies);
    await app.ready();

    const response = await app.inject({
      method: 'POST',
      url: '/api/messages',
      headers: { 'x-cat-cafe-user': 'user-1', 'content-type': 'application/json' },
      payload: { content: '这个方案是脚手架', threadId: 'thread-1' },
    });
    await new Promise((resolve) => setImmediate(resolve));

    assert.equal(response.statusCode, 202, response.body);
    assert.equal(detected.length, 1);
    assert.equal(detected[0].messageId, 'message-1');
    assert.equal(detected[0].ownerUserId, 'user-1');
  });
});
