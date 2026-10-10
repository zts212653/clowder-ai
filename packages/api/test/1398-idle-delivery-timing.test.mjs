import './helpers/setup-cat-registry.js';
import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import { test } from 'node:test';
import Fastify from 'fastify';
import { InvocationQueue } from '../src/domains/cats/services/agents/invocation/InvocationQueue.js';
import { InvocationRegistry } from '../src/domains/cats/services/agents/invocation/InvocationRegistry.js';
import { InvocationTracker } from '../src/domains/cats/services/agents/invocation/InvocationTracker.js';
import { QueueProcessor } from '../src/domains/cats/services/agents/invocation/QueueProcessor.js';
import { routeSerial } from '../src/domains/cats/services/agents/routing/route-serial.js';
import { SessionManager } from '../src/domains/cats/services/session/SessionManager.js';
import { InMemoryTurnExecutionStore } from '../src/domains/cats/services/stores/memory/InMemoryTurnExecutionStore.js';
import { InvocationRecordStore } from '../src/domains/cats/services/stores/ports/InvocationRecordStore.js';
import { MessageStore } from '../src/domains/cats/services/stores/ports/MessageStore.js';
import { messagesRoutes } from '../src/routes/messages.js';

function deferred() {
  let resolve;
  const promise = new Promise((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

// Actual HTTP -> atomic ledger -> QueueProcessor -> routeSerial -> invokeSingleCat
// -> fixed History response. Only provider I/O is controlled. All stores are
// fresh in-memory instances; no service, Redis, runtime file or user data.
test('idle delivery timing distinguishes local admission from slow provider startup and context reads', async (t) => {
  const queue = new InvocationQueue(undefined, {
    onAdmitted: ({ threadId }) => {
      void processor.requestDrain(threadId);
    },
  });
  const messages = new MessageStore();
  const readById = messages.getById.bind(messages);
  const readByThread = messages.getByThread.bind(messages);
  const turns = new InMemoryTurnExecutionStore();
  const records = new InvocationRecordStore();
  const registry = new InvocationRegistry({ turnExecutionStore: turns });
  const tracker = new InvocationTracker();
  const events = [];
  const timings = [];
  const debugStarts = [];
  const counters = {};
  let providerBarrier;
  let contextBarrier;
  let providerEntered = deferred();
  let contextEntered = deferred();
  const counted =
    (name, fn) =>
    async (...args) => {
      const start = performance.now();
      counters[name] ??= { calls: 0, durationMs: 0 };
      const counter = counters[name];
      counter.calls++;
      try {
        return await fn(...args);
      } finally {
        counter.durationMs += performance.now() - start;
      }
    };
  for (const name of ['getById', 'getByThread', 'getByThreadAfter', 'appendAndObservePriorFrontier']) {
    messages[name] = counted(`messageStore.${name}`, messages[name].bind(messages));
  }
  const service = {
    async *invoke() {
      events.push({ stage: 'provider_entered', at: performance.now() });
      providerEntered.resolve();
      await providerBarrier?.promise;
      yield { type: 'text', catId: 'opus', content: 'fixture result', timestamp: Date.now() };
      yield { type: 'done', catId: 'opus', timestamp: Date.now() };
    },
  };
  const deps = {
    services: { opus: service },
    messageStore: messages,
    invocationDeps: {
      registry,
      turnExecutionStore: turns,
      sessionManager: new SessionManager(),
      apiUrl: 'http://127.0.0.1:0',
      threadStore: {
        getParticipantsWithActivity: counted('threadStore.participants', async () => {
          contextEntered.resolve();
          await contextBarrier?.promise;
          return [];
        }),
        get: counted('threadStore.get', async (id) => ({
          id,
          createdBy: 'owner',
          projectPath: '/tmp',
          createdAt: 1,
          lastActiveAt: 1,
          title: null,
          participants: [],
        })),
        addParticipants: async () => {},
        updateParticipantActivity: async () => {},
        consumeMentionRoutingFeedback: async () => null,
      },
    },
  };
  const router = {
    resolveExplicitTargets: async (targets) => [...targets],
    resolveTargetsAndIntent: async () => ({
      targetCats: ['opus'],
      intent: { intent: 'execute', explicit: true },
      hasMentions: true,
    }),
    resolveConversationTargetsAtAdmission: async (targets) => [...targets],
    async *routeExecution(userId, content, threadId, _messageId, targets, _intent, options) {
      events.push({ stage: 'route_entered', at: performance.now() });
      yield* routeSerial(deps, targets, content, userId, threadId, options);
    },
    ackCollectedCursors: async () => {},
  };
  const socketManager = {
    broadcastAgentMessage() {},
    broadcastToRoom() {},
    emitToUser(_owner, type, data) {
      if (type === 'queue_updated')
        events.push({
          stage: 'queue_socket',
          at: performance.now(),
          action: data.action,
          pendingTargets: data.queue.flatMap((row) => row.targetCats),
        });
    },
  };
  const processor = new QueueProcessor({
    queue,
    messageStore: messages,
    invocationTracker: tracker,
    turnExecutionStore: turns,
    invocationRecordStore: {
      create: async (input) => records.create(input),
      get: (id) => records.get(id),
      update: async (id, update) => records.update(id, update),
    },
    router,
    socketManager,
    log: {
      debug(data, label) {
        if (label === 'Delivery queue preparation started') debugStarts.push(data);
      },
      info(data, label) {
        if (label === 'Delivery admission timing') timings.push(data);
      },
      warn() {},
      error() {},
    },
  });
  const app = Fastify();
  await app.register(messagesRoutes, {
    registry,
    messageStore: messages,
    invocationQueue: queue,
    queueProcessor: processor,
    invocationTracker: tracker,
    router,
    socketManager,
  });
  t.after(() => app.close());
  async function send(threadId) {
    const start = performance.now();
    events.push({ stage: 'http_start', at: start });
    const reply = await app.inject({
      method: 'POST',
      url: '/api/messages',
      headers: { 'x-cat-cafe-user': 'owner' },
      payload: { content: '@opus 简单消息', mentions: ['opus'], threadId },
    });
    events.push({ stage: 'http_end', at: performance.now() });
    assert.equal(reply.statusCode, 202, reply.body);
    return { start, id: reply.json().userMessageId };
  }
  async function settle(threadId) {
    // Await causal terminal truth, not a fixed latency/sleep performance budget.
    const deadline = performance.now() + 2_000;
    while (performance.now() < deadline) {
      const response = (await readByThread(threadId, 30, 'owner')).find((m) => m.lifecycle?.kind === 'response');
      if (response?.lifecycle.status === 'completed') return response;
      await new Promise((r) => setTimeout(r, 5));
    }
    assert.fail(
      `controlled provider result did not settle: ${JSON.stringify(await readByThread(threadId, 30, 'owner'))}`,
    );
  }
  const reports = [];
  for (const scenario of ['cold-idle', 'warm-idle', 'provider-blocked', 'context-blocked']) {
    events.length = 0;
    timings.length = 0;
    debugStarts.length = 0;
    for (const key of Object.keys(counters)) delete counters[key];
    providerEntered = deferred();
    contextEntered = deferred();
    providerBarrier = scenario === 'provider-blocked' ? deferred() : undefined;
    contextBarrier = scenario === 'context-blocked' ? deferred() : undefined;
    const threadId = `timing-${scenario}`;
    const sent = await send(threadId);
    try {
      if (contextBarrier) {
        await contextEntered.promise;
        assert.equal(queue.list(threadId, 'owner').length, 1);
        assert.equal(
          (await readByThread(threadId, 30, 'owner')).some((m) => m.lifecycle?.kind === 'response'),
          false,
        );
        // Evidence of the remaining preparation-before-response dependency.
        // This is not an assertion that the user's measured 910ms is explained.
        contextBarrier.resolve();
      }
      await providerEntered.promise;
      assert.equal(queue.list(threadId, 'owner').length, 0, 'provider startup must not hold delivered work in Queue');
      const source = await readById(sent.id);
      assert.equal(debugStarts.length, 1);
      assert.equal(debugStarts[0].sourceMessageId, source.id);
      assert.equal(debugStarts[0].threadId, threadId);
      assert.ok(Number.isFinite(debugStarts[0].queueAgeMs));
      assert.equal(debugStarts[0].content, undefined, 'timing logs must not include message bodies');
      assert.equal(source.lifecycle.dispatchRefs.length, 1);
      const ref = source.lifecycle.dispatchRefs[0];
      const response = await readById(ref.statusMessageId);
      assert.equal(response.lifecycle.kind, 'response');
      assert.ok(turns.get(response.lifecycle.invocationId));
      assert.ok(events.some((e) => e.stage === 'queue_socket' && e.pendingTargets.length === 0));
      providerBarrier?.resolve();
      const terminal = await settle(threadId);
      assert.equal(terminal.id, response.id);
      assert.equal(terminal.content, 'fixture result');
      reports.push({
        scenario,
        events: events.map((e) => ({ ...e, at: e.at - sent.start })),
        timings: structuredClone(timings),
        debugStarts: structuredClone(debugStarts),
        counters: structuredClone(counters),
      });
    } finally {
      providerBarrier?.resolve();
      contextBarrier?.resolve();
    }
  }
  console.log(
    JSON.stringify({
      kind: 'owned-idle-delivery-timing',
      reports,
      limitations: [
        'In-memory controlled I/O, not a runtime SQLite/Redis benchmark.',
        'Context preparation still precedes canonical response admission; latency analysis is deferred to operator acceptance (thread message 253).',
        'No attribution of the runtime 910ms without corresponding stage measurements.',
      ],
    }),
  );
});
