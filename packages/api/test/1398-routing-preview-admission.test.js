import './helpers/setup-cat-registry.js';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import Fastify from 'fastify';
import { InvocationQueue } from '../dist/domains/cats/services/agents/invocation/InvocationQueue.js';
import { InvocationRegistry } from '../dist/domains/cats/services/agents/invocation/InvocationRegistry.js';
import { InvocationTracker } from '../dist/domains/cats/services/agents/invocation/InvocationTracker.js';
import { QueueProcessor } from '../dist/domains/cats/services/agents/invocation/QueueProcessor.js';
import { AgentRegistry } from '../dist/domains/cats/services/agents/registry/AgentRegistry.js';
import { AgentRouter } from '../dist/domains/cats/services/agents/routing/AgentRouter.js';
import { InvocationRecordStore } from '../dist/domains/cats/services/stores/ports/InvocationRecordStore.js';
import { MessageStore } from '../dist/domains/cats/services/stores/ports/MessageStore.js';
import { ThreadStore } from '../dist/domains/cats/services/stores/ports/ThreadStore.js';
import { messagesRoutes } from '../dist/routes/messages.js';
import { routingPreviewRoutes } from '../dist/routes/routing-preview.js';

async function fixture(t, { legacyTargetless = false } = {}) {
  const agents = new AgentRegistry();
  for (const catId of ['opus', 'codex', 'gemini']) {
    agents.register(catId, {
      async *invoke() {
        throw new Error('Admission must not invoke a provider');
      },
    });
  }
  const messages = new MessageStore();
  const threads = new ThreadStore();
  const thread = threads.create('owner', 'real preview and admission');
  const registry = new InvocationRegistry();
  const router = new AgentRouter({ agentRegistry: agents, registry, messageStore: messages, threadStore: threads });
  const queue = new InvocationQueue(
    undefined,
    legacyTargetless
      ? {}
      : {
          resolveTargets: (targets, threadId, content, exact) =>
            router.resolveSendTargets(targets, threadId, content, exact),
        },
  );
  const app = Fastify();
  t.after(() => app.close());
  await app.register(routingPreviewRoutes, { threadStore: threads, router });
  await app.register(messagesRoutes, {
    registry,
    router,
    invocationQueue: queue,
    messageStore: messages,
    threadStore: threads,
    socketManager: { broadcastToRoom() {}, emitToUser() {}, broadcastAgentMessage() {} },
  });
  const reply = (catId, healthy = true) => {
    messages.append({
      from: { kind: 'agent', catId },
      userId: 'owner',
      threadId: thread.id,
      content: 'Existing reply without lifecycle metadata',
      mentions: [],
      timestamp: Date.now() - 1000,
    });
    threads.updateParticipantActivity(thread.id, catId, healthy);
  };
  const mention = (catId) =>
    messages.append({
      from: { kind: 'user', userId: 'owner' },
      userId: 'owner',
      threadId: thread.id,
      content: `@${catId} continue here`,
      mentions: [catId],
      timestamp: Date.now(),
    });
  return { app, agents, router, queue, messages, threads, thread, reply, mention };
}

test('legacy targetless Queue recovery applies the original content policy', async (t) => {
  const f = await fixture(t, { legacyTargetless: true });
  f.reply('opus');
  f.threads.updateRoutingPolicy(f.thread.id, {
    v: 1,
    scopes: { review: { avoidCats: ['opus'], preferCats: ['codex'] } },
  });
  const sent = await f.app.inject({
    method: 'POST',
    url: '/api/messages',
    headers: { 'x-cat-cafe-user': 'owner' },
    payload: { threadId: f.thread.id, content: 'please review this change', idempotencyKey: randomUUID() },
  });
  assert.equal(sent.statusCode, 202, sent.body);
  assert.deepEqual(
    f.queue.list(f.thread.id, 'owner')[0].targets,
    [],
    'simulate a legacy writer without admission resolution',
  );
  const deliveries = [];
  const delivered = Promise.withResolvers();
  // Keep actual admission, recovery policy and Queue processing; replace only the
  // provider execution boundary to observe its exact recipient without a model call.
  f.router.routeExecution = async function* (...args) {
    const [userId, content, threadId, , targetCats, , options] = args;
    deliveries.push({ content, targetCats });
    delivered.resolve();
    await options.onLifecycleInvocationStarted({
      userId,
      threadId,
      catId: targetCats[0],
      invocationId: randomUUID(),
      parentInvocationId: options.parentInvocationId,
      startedAt: Date.now(),
    });
    yield { type: 'done', catId: targetCats[0], isFinal: true, timestamp: Date.now() };
  };
  const processor = new QueueProcessor({
    queue: f.queue,
    invocationTracker: new InvocationTracker(),
    invocationRecordStore: new InvocationRecordStore(),
    messageStore: f.messages,
    router: f.router,
    socketManager: { emitToUser() {}, broadcastAgentMessage() {}, broadcastToRoom() {} },
    log: { info() {}, warn() {}, error() {} },
  });
  const attempt = await processor.processNext(f.thread.id, 'owner');
  assert.equal(attempt.started, true);
  await delivered.promise;
  assert.deepEqual(deliveries, [{ content: 'please review this change', targetCats: ['codex'] }]);
});

const cases = [
  ...['@thread', '@本帖', '@全体参与者'].flatMap((group) => [
    {
      name: `empty ${group} uses the conversation preference`,
      content: `${group} continue`,
      arrange: (f) => f.threads.updatePreferredCats(f.thread.id, ['codex']),
      expected: ['codex'],
    },
    ...[`${group} @gemini continue`, `@gemini ${group} continue`].map((content) => ({
      name: `empty group mixed with an explicit member: ${content}`,
      content,
      arrange: (f) => f.threads.updatePreferredCats(f.thread.id, ['codex']),
      expected: ['gemini'],
    })),
    {
      name: `${group} with only unavailable participants uses the preference`,
      content: `${group} continue`,
      arrange: (f) => {
        f.threads.addParticipants(f.thread.id, ['opus']);
        f.threads.updatePreferredCats(f.thread.id, ['gemini']);
        f.agents.markUnavailable('opus', { code: 'rejected-account-binding', message: 'unavailable group fixture' });
        f.router.refreshFromRegistry(f.agents);
      },
      expected: ['gemini'],
    },
  ]),
  { name: 'existing thread before lifecycle upgrade', arrange: (f) => f.reply('codex'), expected: ['codex'] },
  {
    name: 'last Human mention wins over another member reply',
    arrange: (f) => {
      f.reply('gemini');
      f.mention('codex');
    },
    expected: ['codex'],
  },
  {
    name: 'new conversation preference',
    arrange: (f) => f.threads.updatePreferredCats(f.thread.id, ['codex']),
    expected: ['codex'],
  },
  {
    name: 'concierge duty preference',
    arrange: (f) => {
      f.mention('gemini');
      f.threads.updatePreferredCats(f.thread.id, ['codex']);
      f.threads.updateThreadKind(f.thread.id, 'concierge');
    },
    expected: ['codex'],
  },
  {
    name: 'thread scoped review policy',
    content: 'please review this change',
    arrange: (f) => {
      f.reply('opus');
      f.threads.updateRoutingPolicy(f.thread.id, {
        v: 1,
        scopes: { review: { avoidCats: ['opus'], preferCats: ['codex'] } },
      });
    },
    expected: ['codex'],
  },
  {
    name: 'explicit ideation with preferred members',
    content: '#ideate compare these options',
    arrange: (f) => f.threads.updatePreferredCats(f.thread.id, ['codex', 'gemini']),
    expected: ['codex', 'gemini'],
  },
  {
    name: 'unhealthy reply does not take over history',
    arrange: (f) => {
      f.reply('codex');
      f.reply('gemini', false);
    },
    expected: ['codex'],
  },
  {
    name: 'current explicit mention overrides history and preference',
    content: '@gemini this one is for you',
    arrange: (f) => {
      f.reply('codex');
      f.mention('opus');
    },
    expected: ['gemini'],
  },
  {
    name: 'unavailable ordinary mention has the same visible fallback',
    content: '@opus continue',
    arrange: (f) => {
      f.reply('codex');
      f.agents.markUnavailable('opus', { code: 'rejected-account-binding', message: 'unavailable fixture' });
      f.router.refreshFromRegistry(f.agents);
    },
    expected: ['codex'],
  },
];

test('frozen prose expansion does not allow a retry to change content, explicit targets or visibility', async (t) => {
  const f = await fixture(t);
  f.threads.updatePreferredCats(f.thread.id, ['codex']);
  const payload = { threadId: f.thread.id, content: '@thread continue', idempotencyKey: randomUUID() };
  const send = (body) =>
    f.app.inject({
      method: 'POST',
      url: '/api/messages',
      headers: { 'x-cat-cafe-user': 'owner' },
      payload: body,
    });
  const first = await send(payload);
  assert.equal(first.statusCode, 202, first.body);
  for (const changed of [
    { content: '@gemini changed request' },
    { mentions: ['gemini'] },
    { visibility: 'whisper', whisperTo: ['codex'] },
  ]) {
    const rejected = await send({ ...payload, ...changed });
    assert.ok(rejected.statusCode >= 400, rejected.body);
    assert.deepEqual(
      f.queue.list(f.thread.id, 'owner').map((entry) => entry.targets),
      [['codex']],
    );
    assert.equal(f.messages.getById(first.json().userMessageId).content, payload.content);
  }
});

for (const group of ['@thread', '@本帖', '@全体参与者']) {
  test(`concurrent HTTP ${group} retries preserve the first admission after stale preflight`, async (t) => {
    const f = await fixture(t);
    f.threads.updatePreferredCats(f.thread.id, ['codex']);
    const firstCanProceed = Promise.withResolvers();
    const firstCompleted = Promise.withResolvers();
    const originalRead = f.messages.getByIdempotencyKey.bind(f.messages);
    let reads = 0;
    f.messages.getByIdempotencyKey = (...args) => {
      const snapshot = originalRead(...args);
      if (++reads === 1) return firstCanProceed.promise.then(() => snapshot);
      if (reads === 2) {
        firstCanProceed.resolve();
        return firstCompleted.promise.then(() => snapshot);
      }
      return snapshot;
    };
    const request = {
      method: 'POST',
      url: '/api/messages',
      headers: { 'x-cat-cafe-user': 'owner' },
      payload: { threadId: f.thread.id, content: `${group} continue`, idempotencyKey: randomUUID() },
    };
    const first = f.app.inject(request).then((response) => {
      firstCompleted.resolve();
      return response;
    });
    const second = f.app.inject(request);
    const responses = await Promise.all([first, second]);
    for (const response of responses) assert.equal(response.statusCode, 202, response.body);
    assert.equal(responses[0].json().userMessageId, responses[1].json().userMessageId);
    assert.deepEqual(f.messages.getById(responses[0].json().userMessageId).mentions, []);
    assert.deepEqual(
      f.queue.list(f.thread.id, 'owner').map((entry) => entry.targets),
      [['codex']],
    );
  });
}

for (const scenario of cases) {
  test(`composer preview equals actual HTTP Message + Queue admission: ${scenario.name}`, async (t) => {
    const f = await fixture(t);
    scenario.arrange(f);
    const content = scenario.content ?? 'Continue the conversation';
    const preview = await f.app.inject({
      method: 'POST',
      url: '/api/routing/preview',
      headers: { 'x-cat-cafe-user': 'owner' },
      payload: { scope: 'thread', threadId: f.thread.id, content },
    });
    assert.equal(preview.statusCode, 200, preview.body);
    assert.deepEqual(preview.json().targetCats, scenario.expected, 'visible destination follows the accepted rule');
    const request = {
      method: 'POST',
      url: '/api/messages',
      headers: { 'x-cat-cafe-user': 'owner' },
      payload: { threadId: f.thread.id, content, idempotencyKey: randomUUID() },
    };
    let admitted = await f.app.inject(request);
    if (preview.json().requiresConfirmation) {
      assert.equal(admitted.statusCode, 409, admitted.body);
      assert.equal(f.queue.list(f.thread.id, 'owner').length, 0);
      request.payload.confirmedTargetCats = preview.json().targetCats;
      admitted = await f.app.inject(request);
    }
    assert.equal(admitted.statusCode, 202, admitted.body);
    assert.deepEqual(
      admitted.json().entries.map((entry) => entry.targetCatId),
      preview.json().targetCats,
    );
    const [entry] = f.queue.list(f.thread.id, 'owner');
    assert.deepEqual(entry.targets, scenario.expected, 'persisted Queue targets match the preview');
    assert.equal(f.messages.getById(admitted.json().userMessageId).content, content);
    f.threads.updatePreferredCats(f.thread.id, ['opus']);
    f.mention('gemini');
    const replay = await f.app.inject(request);
    assert.equal(replay.statusCode, 202, replay.body);
    assert.equal(replay.json().userMessageId, admitted.json().userMessageId);
    assert.deepEqual(
      f.queue.list(f.thread.id, 'owner')[0].targets,
      scenario.expected,
      'same-ID retry keeps its admitted recipient',
    );
    assert.equal(f.queue.list(f.thread.id, 'owner').length, 1);
  });
}

for (const scenario of [
  ...cases,
  {
    name: 'unrecognized mention',
    content: '@missing-member continue',
    arrange: (f) => f.reply('codex'),
    expected: ['codex'],
  },
  {
    name: 'removed member mention',
    content: '@removed-member continue',
    arrange: (f) => f.reply('codex'),
    expected: ['codex'],
  },
]) {
  test(`plugin conversation uses the actual user queue routing: ${scenario.name}`, async (t) => {
    const { createMessagingDomain } = await import('../dist/domains/messaging/index.js');
    const { createPluginMessagingHost } = await import('../dist/domains/plugin/host-surface/plugin-messaging-host.js');
    const { createPluginConversationDelivery } = await import(
      '../dist/domains/plugin/host-surface/plugin-conversation-delivery.js'
    );
    const f = await fixture(t);
    scenario.arrange(f);
    const content = scenario.content ?? 'Continue the conversation';
    const expected = await f.router.resolveSendTargets([], f.thread.id, content);
    const messaging = createMessagingDomain({
      messageStore: f.messages,
      invokeTrigger: createPluginConversationDelivery({ messageStore: f.messages, queue: f.queue, router: f.router }),
    });
    const host = createPluginMessagingHost({
      pluginId: 'dev.fixture.notification',
      pluginInstanceId: 'plugin-notification',
      ownerUserId: 'owner',
      threadStore: f.threads,
      messageStore: f.messages,
      messaging,
      manifest: {
        pluginId: 'dev.fixture.notification',
        contributions: [{ type: 'identity', id: 'notification', displayName: 'Notification' }],
        features: [
          {
            id: 'notification',
            contributions: [{ type: 'identity', id: 'notification' }],
            capabilities: ['messaging.send'],
          },
        ],
      },
    });
    const input = {
      threadId: f.thread.id,
      idempotencyKey: randomUUID(),
      wake: 'auto',
      payload: {
        provenance: { epistemicStatus: 'observation' },
        elements: [{ elementId: 'text', kind: 'text', payload: { text: content } }],
      },
    };
    const receipt = await host.send(input);
    assert.deepEqual(await host.send(input), receipt);
    assert.equal(f.messages.getById(receipt.messageId).content, content);
    const entries = f.queue.list(f.thread.id, 'owner');
    assert.equal(entries.length, 1);
    assert.deepEqual(entries[0].targets, expected);
    assert.deepEqual(entries[0].targets, scenario.expected);
    assert.equal(entries[0].kind, 'conversation_input');
    // Exercise the real queue drain; substitute only the model invocation boundary.
    const delivered = Promise.withResolvers();
    f.router.routeExecution = async function* (userId, body, threadId, _unused, targets, _history, options) {
      delivered.resolve({ body, targets });
      await options.onLifecycleInvocationStarted({
        userId,
        threadId,
        catId: targets[0],
        invocationId: randomUUID(),
        parentInvocationId: options.parentInvocationId,
        startedAt: Date.now(),
      });
      yield { type: 'done', catId: targets[0], isFinal: true, timestamp: Date.now() };
    };
    const processor = new QueueProcessor({
      queue: f.queue,
      invocationTracker: new InvocationTracker(),
      invocationRecordStore: new InvocationRecordStore(),
      messageStore: f.messages,
      router: f.router,
      socketManager: { emitToUser() {}, broadcastAgentMessage() {}, broadcastToRoom() {} },
      log: { info() {}, warn() {}, error() {} },
    });
    assert.equal((await processor.processNext(f.thread.id, 'owner')).started, true);
    assert.deepEqual(await delivered.promise, { body: content, targets: scenario.expected });
  });
}
