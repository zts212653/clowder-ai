import assert from 'node:assert/strict';
import { catRegistry } from '@cat-cafe/shared';
import Fastify from 'fastify';
import { WaitContinuationRetryCommitter } from '../../dist/domains/ball-custody/WaitContinuationRetryCommitter.js';
import { WaitContinuationRetryPreflight } from '../../dist/domains/ball-custody/WaitContinuationRetryPreflight.js';
import { InvocationQueue } from '../../dist/domains/cats/services/agents/invocation/InvocationQueue.js';
import { InvocationRegistry } from '../../dist/domains/cats/services/agents/invocation/InvocationRegistry.js';
import { InvocationTracker } from '../../dist/domains/cats/services/agents/invocation/InvocationTracker.js';
import { QueuedMessageCustodyCoordinator } from '../../dist/domains/cats/services/agents/invocation/QueuedMessageCustodyCoordinator.js';
import { QueuedMessageCustodyStartupReconciler } from '../../dist/domains/cats/services/agents/invocation/QueuedMessageCustodyStartupReconciler.js';
import { QueueProcessor } from '../../dist/domains/cats/services/agents/invocation/QueueProcessor.js';
import { routeParallel } from '../../dist/domains/cats/services/agents/routing/route-parallel.js';
import { CloudInvokeBridge } from '../../dist/domains/cats/services/cloud-bridge/cloud-invoke-bridge.js';
import { InMemoryTurnExecutionStore } from '../../dist/domains/cats/services/stores/memory/InMemoryTurnExecutionStore.js';
import { InvocationRecordStore } from '../../dist/domains/cats/services/stores/ports/InvocationRecordStore.js';
import { MessageStore } from '../../dist/domains/cats/services/stores/ports/MessageStore.js';
import { ThreadStore } from '../../dist/domains/cats/services/stores/ports/ThreadStore.js';
import { messagesRoutes } from '../../dist/routes/messages.js';
import { threadsRoutes } from '../../dist/routes/threads.js';

export async function waitFor(predicate, detail = 'production route completion') {
  const deadline = Date.now() + 4000;
  while (!(await predicate())) {
    assert.ok(Date.now() < deadline, `Timed out: ${detail}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

export async function firstMessageHarness({
  bound = false,
  targetCats = ['gpt-pro'],
  beforeAppend,
  configureApp,
} = {}) {
  if (!catRegistry.has('gpt-pro')) {
    catRegistry.register('gpt-pro', {
      catId: 'gpt-pro',
      provider: 'openai-chatgpt-pro',
      clientId: 'openai',
      avatar: '/avatars/gpt-pro.png',
    });
  }
  const userId = 'first-message-owner';
  const messageStore = new MessageStore();
  // Production Redis supplies this scan; the memory test store intentionally does not.
  messageStore.scanByDeliveryStatus = (status) =>
    messageStore
      .getRecent(2_000)
      .filter((message) => message.deliveryStatus === status)
      .map((message) => message.id);
  const threadStore = new ThreadStore();
  const thread = await threadStore.create(userId, 'First cloud message');
  const registry = new InvocationRegistry();
  const invocationRecordStore = new InvocationRecordStore();
  const turnExecutionStore = new InMemoryTurnExecutionStore();
  const tracker = new InvocationTracker();
  const hostCalls = [];
  const routeCalls = [];
  const broadcasts = [];
  const logs = [];
  const log = Object.fromEntries(
    ['info', 'warn', 'error'].map((level) => [level, (...args) => logs.push({ level, args })]),
  );
  const socketManager = {
    broadcastAgentMessage: (message) => broadcasts.push(message),
    broadcastToRoom: () => {},
    emitToUser: () => {},
  };
  const bridge = new CloudInvokeBridge({
    threadStore,
    hostAdapter: {
      append_message: async (conversationId, text, idempotencyKey) => {
        const replay = hostCalls.some((call) => call.idempotencyKey === idempotencyKey);
        hostCalls.push({ conversationId, text, idempotencyKey });
        return { hostMessageId: `host-${idempotencyKey}`, idempotentReplay: replay };
      },
    },
    emitFallback: async () => {},
  });
  if (bound) await threadStore.updateCloudCatBinding(thread.id, 'gpt-pro', 'https://chatgpt.com/c/bound-chat');
  const routeDeps = {
    services: Object.fromEntries(
      targetCats.map((catId) => [
        catId,
        {
          usesChainKeyResume: () => false,
          freshnessCarrierCapability: () => ({ provider: 'other', carrier: 'other', deliverySemantics: 'undeclared' }),
          async *invoke() {
            if (catId === 'gpt-pro') throw new Error('Cloud transport must not enter provider CLI');
            yield { type: 'text', catId, content: 'local reply', timestamp: Date.now() };
            yield { type: 'done', catId, timestamp: Date.now() };
          },
        },
      ]),
    ),
    invocationDeps: {
      registry,
      sessionManager: { get: async () => null, set: async () => {} },
      threadStore,
      apiUrl: 'http://localhost:0',
      cloudInvokeBridge: bridge,
      cloudReturnGrantStore: { issue: async () => ({ ok: true, status: 'issued' }) },
      turnExecutionStore,
    },
    messageStore,
    socketManager,
    draftStore: { delete: async () => {}, touch: async () => {}, upsert: async () => {} },
  };
  const router = {
    resolveTargetsAndIntent: async () => ({ targetCats, intent: { intent: 'execute' } }),
    resolveExplicitTargets: async (targets) => targets,
    ackCollectedCursors: async () => {},
    async *routeExecution(owner, content, threadId, messageId, targets, _intent, options) {
      routeCalls.push({ messageId, targets });
      yield* routeParallel(routeDeps, targets, content, owner, threadId, {
        ...options,
        currentUserMessageId: messageId,
      });
    },
  };
  let queue = new InvocationQueue();
  const coordinator = new QueuedMessageCustodyCoordinator({ messageStore });
  const makeProcessor = () =>
    new QueueProcessor({
      queue,
      messageStore,
      threadStore,
      queueCustodyCoordinator: coordinator,
      invocationTracker: tracker,
      invocationRecordStore,
      turnExecutionStore,
      router,
      socketManager,
      log,
    });
  let processor = makeProcessor();
  const taskStore = { get: () => null };
  const opts = {
    registry,
    messageStore,
    threadStore,
    router,
    socketManager,
    invocationRecordStore,
    invocationTracker: tracker,
    turnExecutionStore,
    invocationQueue: queue,
    queueProcessor: processor,
    retryAuthorityPreflight: new WaitContinuationRetryPreflight({ taskStore }),
    retryAuthorityCommitter: new WaitContinuationRetryCommitter({ messageStore, taskStore }),
  };
  if (beforeAppend) {
    const append = messageStore.append.bind(messageStore);
    messageStore.append = async (input) => {
      await beforeAppend(input);
      return append(input);
    };
  }
  let app;
  const openApp = async () => {
    app = Fastify();
    await configureApp?.(app, { userId, thread, hostCalls, routeCalls, broadcasts });
    await app.register(messagesRoutes, opts);
    await app.register(threadsRoutes, opts);
    await app.ready();
  };
  await openApp();
  const request = (method, url, payload, owner = userId) =>
    app.inject({
      method,
      url,
      headers: { 'x-cat-cafe-user': owner },
      ...(payload ? { payload } : {}),
    });
  const settle = () =>
    waitFor(
      () =>
        broadcasts.some((event) => event.type === 'done') &&
        !tracker.has(thread.id) &&
        !processor.hasActiveExecution(thread.id),
      JSON.stringify(logs),
    );
  return {
    userId,
    thread,
    messageStore,
    invocationRecordStore,
    turnExecutionStore,
    tracker,
    hostCalls,
    routeCalls,
    broadcasts,
    logs,
    get app() {
      return app;
    },
    get queue() {
      return queue;
    },
    get processor() {
      return processor;
    },
    request,
    settle,
    send: (extra = {}) =>
      request('POST', '/api/messages', { content: '@gpt-pro hello first source', threadId: thread.id, ...extra }),
    bind: () =>
      request('PATCH', `/api/threads/${thread.id}/cloud-bindings`, {
        catId: 'gpt-pro',
        chatUrl: 'https://chatgpt.com/c/bound-chat',
      }),
    authority: (messageId, owner) =>
      request('GET', `/api/messages/${messageId}/queue-targets/gpt-pro/retry-authority`, undefined, owner),
    retry: (messageId, attemptId, owner) =>
      request('POST', `/api/messages/${messageId}/queue-targets/gpt-pro/retry`, { attemptId }, owner),
    async restart() {
      await app.close();
      queue = new InvocationQueue();
      processor = makeProcessor();
      opts.invocationQueue = queue;
      opts.queueProcessor = processor;
      const recovered = await new QueuedMessageCustodyStartupReconciler({
        messageStore,
        invocationRecordStore,
        turnExecutionStore,
        invocationQueue: queue,
        log,
      }).reconcile();
      await openApp();
      return recovered;
    },
    close: () => app.close(),
  };
}
