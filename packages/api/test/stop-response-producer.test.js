/**
 * PR-3a (Astra #6697 R2): a route ends its child turn before it commits that turn's R, so the turn's
 * ending says nothing about whether R is still to come. The route says so itself: it claims each
 * turn's R in the process-wide ResponseProducerRegistry before R is admitted and releases it after
 * its own terminal commit, or when it exits however it exits. A stop that lands inside that window
 * writes neither the turn nor R; the route's own commit then applies, with no persistence failure.
 *
 * Real routes, real invoke-single-cat, real in-memory stores, and — for the exit matrix — a real
 * QueueProcessor driving the real serial route the way AgentRouter.routeExecution does.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

const { MessageStore, commitLifecycleResponseFromTerminalPatch } = await import(
  '../dist/domains/cats/services/stores/ports/MessageStore.js'
);
const { DraftStore } = await import('../dist/domains/cats/services/stores/ports/DraftStore.js');
const { InMemoryTurnExecutionStore } = await import(
  '../dist/domains/cats/services/stores/memory/InMemoryTurnExecutionStore.js'
);
const { InvocationRecordStore } = await import('../dist/domains/cats/services/stores/ports/InvocationRecordStore.js');
const { lifecycleResponseIdempotencyKey } = await import(
  '../dist/domains/cats/services/agents/invocation/response-draft-settlement.js'
);
const { ResponseProducerRegistry, responseProducers } = await import(
  '../dist/domains/cats/services/agents/invocation/response-producer-registry.js'
);
const { closeExecutionChildTurns, STOP_RESPONSE_REASON } = await import('../dist/routes/queue-turn-closure.js');
const { routeSerial } = await import('../dist/domains/cats/services/agents/routing/route-serial.js');
const { routeParallel } = await import('../dist/domains/cats/services/agents/routing/route-parallel.js');

const USER = 'user-stopped';
const THREAD = 'thread-stopped';
const CAT = 'codex';
const ROUTES = { serial: routeSerial, parallel: routeParallel };

describe('PR-3a ResponseProducerRegistry', () => {
  it('a route scope claims, releases one turn, and releases the rest when it exits', () => {
    const registry = new ResponseProducerRegistry();
    const scope = registry.openRouteScope();
    scope.enter('turn-a');
    scope.enter('turn-a');
    scope.enter('turn-b');
    assert.equal(registry.has('turn-a'), true);
    scope.leave('turn-a');
    assert.equal(registry.has('turn-a'), false, 'one leave undoes an idempotent enter');
    scope.leave('turn-a');
    assert.equal(registry.has('turn-b'), true);
    scope.leaveAll();
    assert.equal(registry.has('turn-b'), false);
  });

  it('a scope only releases what it claimed', () => {
    const registry = new ResponseProducerRegistry();
    const first = registry.openRouteScope();
    const second = registry.openRouteScope();
    first.enter('turn-a');
    second.leave('turn-a');
    second.leaveAll();
    assert.equal(registry.has('turn-a'), true);
    first.leaveAll();
    assert.equal(registry.has('turn-a'), false);
  });
});

/** One queue dispatch of one cat, whose provider stream calls `duringStream` before it finishes. */
function world(shape, duringStream) {
  const messages = new MessageStore();
  const drafts = new DraftStore();
  const turns = new InMemoryTurnExecutionStore();
  const records = new InvocationRecordStore();
  const parent = records.create({
    threadId: THREAD,
    userId: USER,
    targetCats: [CAT],
    intent: 'execute',
    idempotencyKey: `queue-entry-${shape}:${CAT}`,
    actionLeaseCarrier: { kind: 'none' },
  }).invocationId;
  records.update(parent, { status: 'running' });
  const w = { messages, drafts, turns, records, parent, children: [], responseIds: new Map() };
  let sequence = 0;
  w.deps = {
    services: {
      [CAT]: {
        async *invoke() {
          // Each shape reaches one persistence branch: text, no-text (tool only), error without text.
          if (shape === 'text') yield { type: 'text', catId: CAT, content: 'partial answer', timestamp: Date.now() };
          if (shape === 'tool-only') {
            yield { type: 'tool_use', catId: CAT, toolName: 'Read', toolInput: { path: 'a' }, timestamp: Date.now() };
          }
          await duringStream(w);
          if (shape === 'provider-error') {
            yield { type: 'error', catId: CAT, error: 'provider exited after SIGTERM', timestamp: Date.now() };
          }
          yield { type: 'done', catId: CAT, timestamp: Date.now() };
        },
      },
    },
    invocationDeps: {
      registry: {
        create: () => {
          const invocationId = `child-${shape}-${++sequence}`;
          w.children.push(invocationId);
          return { invocationId, callbackToken: `token-${sequence}` };
        },
        verify: async () => ({ ok: false, reason: 'unknown_invocation' }),
      },
      sessionManager: {
        getOrCreate: async () => ({}),
        get: async () => null,
        resolveWorkingDirectory: () => '/tmp/test',
      },
      threadStore: null,
      apiUrl: 'http://127.0.0.1:3004',
      turnExecutionStore: turns,
    },
    messageStore: messages,
    draftStore: drafts,
  };
  w.persistenceContext = { failed: false, errors: [] };
  w.options = {
    parentInvocationId: parent,
    persistenceContext: w.persistenceContext,
    onLifecycleInvocationStarted: async (input) => {
      const response = await messages.append({
        from: { kind: 'agent', catId: input.catId },
        userId: input.userId,
        content: '',
        mentions: [],
        origin: 'stream',
        timestamp: input.startedAt,
        threadId: input.threadId,
        idempotencyKey: lifecycleResponseIdempotencyKey(input.invocationId),
        lifecycle: {
          kind: 'response',
          orderKey: `${input.startedAt}:${input.invocationId}`,
          invocationId: input.invocationId,
          targetId: input.catId,
          inputEntryIds: ['entry-1'],
          inputMessageIds: [],
          status: 'processing',
          startedAt: input.startedAt,
        },
      });
      w.responseIds.set(input.invocationId, response.id);
      return { responseMessageId: response.id, priorFrontierMessageId: null };
    },
  };
  return w;
}

/** A stop path's own closure, as the four stop paths and failUncontrollableInvocation run it. */
function stopPathCloses(w, invocationId, { status = 'canceled', reason = STOP_RESPONSE_REASON.userStop } = {}) {
  return closeExecutionChildTurns(
    {
      messageStore: w.messages,
      draftStore: w.drafts,
      turnExecutionStore: w.turns,
      invocationRecordStore: w.records,
      // A real write, so a stop that does settle a failed R is visible as one.
      commitFailedResponse: (response, patch) =>
        commitLifecycleResponseFromTerminalPatch(w.messages, response.id, patch),
      emit: () => {},
    },
    {
      threadId: THREAD,
      userId: USER,
      catId: CAT,
      executionId: w.parent,
      invocationId,
      status,
      reason,
      endedAt: Date.now(),
    },
  );
}

/**
 * The stop lands while the provider stream is still open, i.e. while the route claims R. What it saw
 * is recorded, not asserted: a throw here would be the provider's and change the route's ending.
 */
async function stopMidStream(w) {
  const [child] = w.children;
  const claimed = responseProducers.has(child);
  const closure = await stopPathCloses(w, child);
  w.stop = { claimed, deferred: closure.deferredToProducer };
}

/** Another writer ends R some other way first. */
function otherWriterEnds(status, reason) {
  return async (w) => {
    const [child] = w.children;
    const result = await w.messages.commitLifecycleResponseTerminal(w.responseIds.get(child), {
      invocationId: child,
      status,
      completedAt: Date.now(),
      ...(reason ? { reason } : {}),
      content: 'someone else ended it',
      mentions: [],
    });
    assert.equal(result.kind, 'applied');
  };
}

async function run(route, w) {
  const events = [];
  for await (const event of route(w.deps, [CAT], 'please answer', USER, THREAD, w.options)) events.push(event);
  const done = events.filter((event) => event.type === 'done' && event.catId === CAT).at(-1);
  return { events, done };
}

const SHAPES = {
  text: { status: 'completed', reason: undefined },
  'tool-only': { status: 'completed', reason: undefined },
  'provider-error': { status: 'failed' },
};

describe('PR-3a: a stop inside the route’s commit window leaves R to the route', () => {
  for (const [strategy, route] of Object.entries(ROUTES)) {
    for (const [shape, expected] of Object.entries(SHAPES)) {
      it(`${strategy} / ${shape}: the route's own commit applies, with no persistence failure`, async () => {
        const w = world(shape, stopMidStream);

        await run(route, w);

        assert.deepEqual(w.stop, { claimed: true, deferred: true }, 'the route claims R and the stop defers');
        assert.equal(w.persistenceContext.failed, false, JSON.stringify(w.persistenceContext.errors));
        const [child] = w.children;
        const stored = w.messages.getById(w.responseIds.get(child));
        assert.equal(stored.lifecycle.status, expected.status, 'R carries the route’s own terminal');
        assert.equal(responseProducers.has(child), false, 'the claim ends with the route');
      });
    }

    // Astra #6697 R2 P1-1: the producer has already ended the child; it has not committed R yet.
    for (const [ending, shape] of [
      ['failed', 'provider-error'],
      ['succeeded', 'text'],
    ]) {
      it(`${strategy}: a stop between the child turn ending ${ending} and the route's R commit writes nothing`, async () => {
        const w = world(shape, async () => {});
        const transition = w.turns.transitionTerminal.bind(w.turns);
        let intercepted;
        w.turns.transitionTerminal = async (id, input) => {
          const result = transition(id, input);
          if (!intercepted && result.outcome === 'transitioned' && result.record.status === ending) {
            const responseAtStop = w.messages.getById(w.responseIds.get(id)).lifecycle.status;
            intercepted = { responseAtStop, deferred: (await stopPathCloses(w, id)).deferredToProducer };
          }
          return result;
        };

        await run(route, w);

        // Serial ends the child (invokeSingleCat's finally) before it commits R: the stop lands inside the

        // route's claim and defers. Parallel commits R on the turn's done before that finally runs, so the

        // stop finds R already terminal and only republishes it. Either way no second writer meets the route.

        assert.deepEqual(
          intercepted,

          strategy === 'serial'
            ? { responseAtStop: 'processing', deferred: true }
            : { responseAtStop: intercepted?.responseAtStop, deferred: false },
        );

        if (strategy === 'parallel') assert.notEqual(intercepted.responseAtStop, 'processing');
        const stored = w.messages.getById(w.responseIds.get(w.children[0]));
        assert.equal(stored.lifecycle.status, ending === 'failed' ? 'failed' : 'completed');
        assert.equal(w.persistenceContext.failed, false, JSON.stringify(w.persistenceContext.errors));
      });
    }

    const STILL_FAILURES = [
      ['a canceled R', otherWriterEnds('canceled', 'user_cancel')],
      ['a completed R', otherWriterEnds('completed')],
      ['a failed R', otherWriterEnds('failed', 'provider_error')],
    ];
    for (const [name, writer] of STILL_FAILURES) {
      it(`${strategy}: ${name} written by a non-stop writer inside the window is still a persistence failure`, async () => {
        const w = world('text', writer);

        await run(route, w);

        assert.equal(w.persistenceContext.failed, true);
        assert.match(w.persistenceContext.errors[0]?.error ?? '', /conflict:different_terminal/);
        assert.equal(w.messages.getById(w.responseIds.get(w.children[0])).content, 'someone else ended it');
      });
    }
  }
});

/**
 * A real QueueProcessor executing one queued message through the real serial route. `provider`
 * scripts the cat; `wrapRoute` may intercept the route's events; `wrapAdmission` the R admission.
 */
async function queueWorld(t, { provider, wrapRoute = (events) => events, wrapAdmission = (admit) => admit }) {
  const { InvocationQueue } = await import('../dist/domains/cats/services/agents/invocation/InvocationQueue.js');
  const { InvocationTracker } = await import('../dist/domains/cats/services/agents/invocation/InvocationTracker.js');
  const { QueueProcessor } = await import('../dist/domains/cats/services/agents/invocation/QueueProcessor.js');
  const { InMemoryQueueLedgerStore } = await import(
    '../dist/domains/cats/services/agents/invocation/queue-ledger/InMemoryQueueLedgerStore.js'
  );
  const q = {
    queue: new InvocationQueue(new InMemoryQueueLedgerStore(), { resolveTargets: async (ids) => [...ids] }),
    tracker: new InvocationTracker(),
    messages: new MessageStore(),
    drafts: new DraftStore(),
    turns: new InMemoryTurnExecutionStore(),
    records: new InvocationRecordStore(),
    broadcasts: [],
    children: [],
    claimedMidStream: undefined,
  };
  let sequence = 0;
  const routeDeps = {
    services: { [CAT]: { invoke: (...args) => provider(q, ...args) } },
    invocationDeps: {
      registry: {
        create: () => {
          const invocationId = `queue-child-${++sequence}`;
          q.children.push(invocationId);
          return { invocationId, callbackToken: `token-${sequence}` };
        },
        verify: async () => ({ ok: false, reason: 'unknown_invocation' }),
      },
      sessionManager: {
        getOrCreate: async () => ({}),
        get: async () => null,
        resolveWorkingDirectory: () => '/tmp/test',
      },
      threadStore: null,
      apiUrl: 'http://127.0.0.1:3004',
      turnExecutionStore: q.turns,
    },
    messageStore: q.messages,
    draftStore: q.drafts,
  };
  q.processor = new QueueProcessor({
    queue: q.queue,
    invocationTracker: q.tracker,
    messageStore: q.messages,
    invocationRecordStore: q.records,
    turnExecutionStore: q.turns,
    draftStore: q.drafts,
    socketManager: {
      emitToUser() {},
      broadcastToRoom() {},
      broadcastAgentMessage: (message) => q.broadcasts.push(message),
    },
    worktreeNoticeStartGuard: { check: async () => ({ ok: true }) },
    log: { info() {}, warn() {}, error() {}, debug() {} },
    router: {
      resolveExplicitTargets: async (ids) => [...ids],
      resolveConversationTargetsAtAdmission: async (ids) => [...ids],
      ackCollectedCursors: async () => {},
      // As AgentRouter.routeExecution hands the Queue's options to the strategy.
      routeExecution: (userId, content, threadId, messageId, targets, _intent, options) =>
        wrapRoute(
          routeSerial(routeDeps, targets, content, userId, threadId, {
            ...options,
            currentUserMessageId: messageId,
            onLifecycleInvocationStarted: wrapAdmission(options.onLifecycleInvocationStarted),
          }),
        ),
    },
  });
  t.after(() => q.tracker.cancelAll(THREAD, USER, 'test_cleanup'));
  await q.queue.send(
    q.messages,
    {
      from: { kind: 'user', userId: USER },
      userId: USER,
      threadId: THREAD,
      content: 'please answer',
      mentions: [CAT],
      timestamp: Date.now(),
      deliveryStatus: 'queued',
    },
    {
      kind: 'conversation_input',
      threadId: THREAD,
      userId: USER,
      from: { kind: 'user', userId: USER },
      ownerAuthProvenance: 'unknown',
      content: 'please answer',
      targetCats: [CAT],
      intent: 'execute',
      autoExecute: true,
    },
  );
  await q.processor.requestDrain(THREAD);
  const until = Date.now() + 5_000;
  while (q.processor.hasProcessingSlotReservation(THREAD, CAT) || q.children.length === 0) {
    assert.ok(Date.now() < until, 'the Queue execution must finish');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  return q;
}

/** What the scripted provider saw of the claim while its stream was open. */
function observeClaim(q) {
  q.claimedMidStream = responseProducers.has(q.children.at(-1));
}

describe('PR-3a: the route releases its R claim on every Queue execution exit', () => {
  const EXITS = {
    success: {
      provider: async function* (q) {
        yield { type: 'text', catId: CAT, content: 'the answer', timestamp: Date.now() };
        observeClaim(q);
        yield { type: 'done', catId: CAT, timestamp: Date.now() };
      },
      response: 'completed',
    },
    'provider failure': {
      provider: async function* (q) {
        observeClaim(q);
        yield { type: 'error', catId: CAT, error: 'provider exited', timestamp: Date.now() };
        yield { type: 'done', catId: CAT, timestamp: Date.now() };
      },
      response: 'failed',
    },
    'user Stop': {
      provider: async function* (q) {
        yield { type: 'text', catId: CAT, content: 'partial', timestamp: Date.now() };
        observeClaim(q);
        q.tracker.cancel(THREAD, CAT, USER, 'user_cancel');
        yield { type: 'done', catId: CAT, timestamp: Date.now() };
      },
      response: 'canceled',
    },
    'route abandoned mid-stream': {
      provider: async function* (q) {
        observeClaim(q);
        yield { type: 'text', catId: CAT, content: 'partial', timestamp: Date.now() };
        yield { type: 'done', catId: CAT, timestamp: Date.now() };
      },
      // The Queue loses its route after the first text: its own abandoned-response settlement ends R.
      wrapRoute: async function* (events) {
        for await (const event of events) {
          yield event;
          if (event.type === 'text') throw new Error('route crashed before its R commit');
        }
      },
      response: 'failed',
    },
    'R admission throws': {
      provider: async function* () {
        yield { type: 'done', catId: CAT, timestamp: Date.now() };
      },
      wrapAdmission: () => async (input) => {
        responseProducersSeen.push(responseProducers.has(input.invocationId));
        throw new Error('R admission failed');
      },
      response: null,
    },
  };
  const responseProducersSeen = [];

  for (const [name, exit] of Object.entries(EXITS)) {
    it(`${name}: claimed while the route runs, released after the execution`, async (t) => {
      const q = await queueWorld(t, exit);

      const [child] = q.children;
      if (name === 'R admission throws') assert.deepEqual(responseProducersSeen, [true], 'claimed before admission');
      else assert.equal(q.claimedMidStream, true, 'claimed while the provider streams');
      assert.equal(responseProducers.has(child), false, 'nothing is left claimed to block a later stop');
      const response = q.messages
        .getByThread(THREAD, 100, USER)
        .find((message) => message.lifecycle?.kind === 'response' && message.lifecycle.invocationId === child);
      assert.equal(response?.lifecycle.status ?? null, exit.response);
    });
  }

  it('a stop while the route streams writes nothing; the route ends R and the run as its own', async (t) => {
    let closure;
    const q = await queueWorld(t, {
      provider: async function* (world) {
        yield { type: 'text', catId: CAT, content: 'almost the whole answer', timestamp: Date.now() };
        const [child] = world.children;
        const parent = world.turns.get(child).parentInvocationId;
        closure = await stopPathCloses(
          { messages: world.messages, drafts: world.drafts, turns: world.turns, records: world.records, parent },
          child,
        );
        yield { type: 'done', catId: CAT, timestamp: Date.now() };
      },
    });

    const [child] = q.children;
    assert.equal(closure.deferredToProducer, true);
    const response = q.messages
      .getByThread(THREAD, 100, USER)
      .find((message) => message.lifecycle?.invocationId === child);
    assert.equal(response.lifecycle.status, 'completed');
    assert.equal(q.records.get(q.turns.get(child).parentInvocationId).status, 'succeeded');
    assert.deepEqual(
      q.broadcasts.filter((message) => message.type === 'error').map((message) => message.error),
      [],
      'no “消息已发送但未能保存” or any other error reaches the thread',
    );
  });
});
