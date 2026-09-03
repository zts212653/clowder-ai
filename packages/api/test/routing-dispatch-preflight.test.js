import './helpers/setup-cat-registry.js';
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

function decision(input, dispositions, resolverState = 'fresh') {
  return {
    v: 1,
    ownerId: input.ownerId,
    observedAt: Date.now(),
    resolverState,
    ...(resolverState === 'fresh' ? { snapshotRef: 'snapshot:test' } : {}),
    targets: input.targetCatIds.map((targetCatId) => ({
      targetCatId,
      disposition: dispositions[targetCatId] ?? 'allowed',
      reasons:
        dispositions[targetCatId] === 'allowed'
          ? []
          : [{ code: 'test_routing_state', summary: `test ${dispositions[targetCatId]}`, sourceRefs: ['test:1'] }],
      alternatives: [{ catId: 'terra', reasonRefs: ['test:alternative'] }],
    })),
  };
}

function service(catId, calls) {
  return {
    async *invoke() {
      calls.push(catId);
      yield { type: 'text', catId, content: '@co-creator\ncompleted', timestamp: Date.now() };
      yield { type: 'done', catId, timestamp: Date.now() };
    },
  };
}

function routeDeps(services, routingDispatchPreflight, invocationExtras = {}) {
  let invocation = 0;
  let message = 0;
  return {
    services,
    routingDispatchPreflight,
    invocationDeps: {
      registry: {
        create: () => ({ invocationId: `inv-${++invocation}`, callbackToken: `tok-${invocation}` }),
        verify: async () => ({ ok: false, reason: 'unknown_invocation' }),
      },
      sessionManager: {
        get: async () => undefined,
        getOrCreate: async () => ({}),
        store: async () => {},
        delete: async () => {},
        resolveWorkingDirectory: () => '/tmp/test',
      },
      threadStore: null,
      apiUrl: 'http://127.0.0.1:3004',
      ...invocationExtras,
    },
    messageStore: {
      append: async (input) => ({ id: `msg-${++message}`, ...input }),
      getRecent: () => [],
      getMentionsFor: () => [],
      getBefore: () => [],
      getById: async () => null,
      getByThread: () => [],
      getByThreadAfter: () => [],
      getByThreadBefore: () => [],
    },
  };
}

describe('F293 actual-send routing preflight', () => {
  test('last-resort degradation deduplicates targets and stays total for an empty target set', async () => {
    const { preflightRoutingDispatch } = await import(
      '../dist/domains/routing-context/RoutingDispatchPreflightPort.js'
    );
    const failing = { preflight: async () => Promise.reject(new Error('offline')) };
    const empty = await preflightRoutingDispatch(failing, { ownerId: 'owner-1', targetCatIds: [] });
    assert.deepEqual(empty.targets, []);
    const duplicated = await preflightRoutingDispatch(failing, {
      ownerId: 'owner-1',
      targetCatIds: ['opus', 'opus'],
    });
    assert.deepEqual(
      duplicated.targets.map((target) => target.targetCatId),
      ['opus'],
    );
    assert.equal(
      duplicated.targets[0].reasons[0].summary,
      'Routing context is temporarily unavailable; the requested target remains unchanged',
    );
    assert.doesNotMatch(duplicated.targets[0].reasons[0].summary, /consumer_error/);
  });

  test('runtime adapter reloads the catalog for every decision and preserves targets on catalog failure', async () => {
    const { RuntimeRoutingDispatchPreflight } = await import(
      '../dist/domains/routing-context/RoutingDispatchPreflightPort.js'
    );
    let catalogRevision = 'catalog:1';
    let loads = 0;
    const catalogInputs = [];
    const seen = [];
    const adapter = new RuntimeRoutingDispatchPreflight({
      catalogSource: {
        async load(input) {
          loads++;
          catalogInputs.push(input);
          if (catalogRevision === 'broken') throw new Error('catalog offline');
          return {
            catalogRevision,
            candidates: [{ v: 1, catId: 'opus', providerId: 'anthropic', provenQuotaPools: [] }],
          };
        },
      },
      preflightService: {
        async preflight(input) {
          seen.push(input.catalogRevision);
          return decision(input, { opus: input.catalogRevision === 'catalog:2' ? 'rejected' : 'allowed' });
        },
      },
      now: () => 10_000,
    });

    assert.equal(
      (await adapter.preflight({ ownerId: 'owner-1', targetCatIds: ['opus'] })).targets[0].disposition,
      'allowed',
    );
    catalogRevision = 'catalog:2';
    assert.equal(
      (await adapter.preflight({ ownerId: 'owner-1', targetCatIds: ['opus'] })).targets[0].disposition,
      'rejected',
    );
    catalogRevision = 'broken';
    const degraded = await adapter.preflight({ ownerId: 'owner-1', targetCatIds: ['opus'] });
    assert.equal(degraded.resolverState, 'degraded');
    assert.equal(degraded.targets[0].disposition, 'warned');
    assert.deepEqual(seen, ['catalog:1', 'catalog:2']);
    assert.equal(loads, 3);
    assert.deepEqual(catalogInputs, [{ ownerId: 'owner-1' }, { ownerId: 'owner-1' }, { ownerId: 'owner-1' }]);
  });

  test('serial mixed targets reject only the unavailable child and let warned target proceed unchanged', async () => {
    const { routeSerial } = await import('../dist/domains/cats/services/agents/routing/route-serial.js');
    const calls = [];
    const preflightInputs = [];
    const deps = routeDeps(
      { opus: service('opus', calls), codex: service('codex', calls) },
      {
        async preflight(input) {
          preflightInputs.push(input);
          return decision(input, { opus: 'rejected', codex: 'warned' });
        },
      },
    );
    const events = [];
    for await (const event of routeSerial(deps, ['opus', 'codex'], 'review this', 'owner-1', 'thread-serial', {
      routingContextIntent: 'review',
    })) {
      events.push(event);
    }

    assert.ok(!calls.includes('opus'), 'rejected target must not create a provider child');
    assert.ok(calls.includes('codex'), 'warned target must retain the original target');
    assert.deepEqual(
      preflightInputs.slice(0, 2).map((input) => ({ targetCatIds: input.targetCatIds, intent: input.intent })),
      [
        { targetCatIds: ['opus'], intent: 'review' },
        { targetCatIds: ['codex'], intent: 'review' },
      ],
    );
    const receipts = events
      .filter((event) => event.type === 'system_info' && event.content?.includes('routing_preflight'))
      .map((event) => JSON.parse(event.content));
    assert.ok(
      receipts.some((receipt) => receipt.target.targetCatId === 'opus' && receipt.target.disposition === 'rejected'),
    );
    assert.ok(
      receipts.some((receipt) => receipt.target.targetCatId === 'codex' && receipt.target.disposition === 'warned'),
    );
  });

  test('consumer failure degrades to warned and preserves the exact original target', async () => {
    const { routeSerial } = await import('../dist/domains/cats/services/agents/routing/route-serial.js');
    const calls = [];
    const deps = routeDeps(
      { opus: service('opus', calls) },
      { preflight: async () => Promise.reject(new Error('resolver unavailable')) },
    );
    const events = [];
    for await (const event of routeSerial(deps, ['opus'], 'ordinary work', 'owner-1', 'thread-degraded')) {
      events.push(event);
    }

    assert.ok(calls.includes('opus'));
    const receipt = events
      .filter((event) => event.type === 'system_info' && event.content?.includes('routing_preflight'))
      .map((event) => JSON.parse(event.content))[0];
    assert.equal(receipt.resolverState, 'degraded');
    assert.equal(receipt.target.targetCatId, 'opus');
    assert.equal(receipt.target.disposition, 'warned');
    assert.deepEqual(receipt.target.alternatives, []);
  });

  test('serial deferred A2A checks fresh state before creating a queue entry', async () => {
    const { routeSerial } = await import('../dist/domains/cats/services/agents/routing/route-serial.js');
    const calls = [];
    const deferred = [];
    const deps = routeDeps(
      {
        opus: {
          async *invoke() {
            calls.push('opus');
            yield { type: 'text', catId: 'opus', content: '@codex\ncontinue from here', timestamp: Date.now() };
            yield { type: 'done', catId: 'opus', timestamp: Date.now() };
          },
        },
        codex: service('codex', calls),
      },
      { preflight: async (input) => decision(input, { opus: 'allowed', codex: 'rejected' }) },
    );
    const events = [];
    for await (const event of routeSerial(deps, ['opus'], 'start', 'owner-1', 'thread-deferred', {
      queueHasQueuedMessages: () => true,
      deferA2AEnqueue: (entry) => {
        deferred.push(entry);
        return { outcome: 'enqueued' };
      },
    })) {
      events.push(event);
    }

    assert.deepEqual(calls, ['opus']);
    assert.deepEqual(deferred, [], 'rejected dynamic target must never enter InvocationQueue');
    assert.ok(
      events.some(
        (event) =>
          event.type === 'system_info' &&
          event.content?.includes('routing_preflight') &&
          JSON.parse(event.content).target.targetCatId === 'codex',
      ),
    );
  });

  test('parallel mixed targets never invoke the rejected child', async () => {
    const { routeParallel } = await import('../dist/domains/cats/services/agents/routing/route-parallel.js');
    const calls = [];
    const deps = routeDeps(
      { opus: service('opus', calls), codex: service('codex', calls) },
      { preflight: async (input) => decision(input, { opus: 'rejected', codex: 'allowed' }) },
    );
    const events = [];
    for await (const event of routeParallel(deps, ['opus', 'codex'], 'ideate', 'owner-1', 'thread-parallel')) {
      events.push(event);
    }

    assert.ok(!calls.includes('opus'));
    assert.ok(calls.includes('codex'));
    assert.ok(
      events.some(
        (event) =>
          event.type === 'system_info' &&
          event.content?.includes('routing_preflight') &&
          JSON.parse(event.content).target.disposition === 'rejected',
      ),
    );
  });

  test('serial and parallel invocations retain the exact actual-send decision through durable terminal observation', async () => {
    const { routeSerial } = await import('../dist/domains/cats/services/agents/routing/route-serial.js');
    const { routeParallel } = await import('../dist/domains/cats/services/agents/routing/route-parallel.js');
    const { InMemoryTurnExecutionStore } = await import(
      '../dist/domains/cats/services/stores/memory/InMemoryTurnExecutionStore.js'
    );
    const calls = [];
    const observed = [];
    const returnedDecisions = [];
    const preflight = {
      async preflight(input) {
        const exact = decision(input, Object.fromEntries(input.targetCatIds.map((catId) => [catId, 'allowed'])));
        returnedDecisions.push(exact);
        return exact;
      },
    };
    const observer = { observeTerminal: async (evidence) => observed.push(evidence) };

    const serialDeps = routeDeps({ opus: service('opus', calls) }, preflight, {
      turnExecutionStore: new InMemoryTurnExecutionStore(),
      routingDispatchSignalObserver: observer,
    });
    for await (const _event of routeSerial(serialDeps, ['opus'], 'serial', 'owner-1', 'thread-serial-evidence')) {
      // exhaust the route so the durable terminal observer runs
    }

    const parallelDeps = routeDeps({ opus: service('opus', calls), codex: service('codex', calls) }, preflight, {
      turnExecutionStore: new InMemoryTurnExecutionStore(),
      routingDispatchSignalObserver: observer,
    });
    for await (const _event of routeParallel(
      parallelDeps,
      ['opus', 'codex'],
      'parallel',
      'owner-1',
      'thread-parallel-evidence',
    )) {
      // exhaust the route so both durable terminal observers run
    }

    assert.equal(returnedDecisions.length, 2);
    assert.equal(observed.length, 3);
    assert.equal(observed[0].preflightDecision, returnedDecisions[0]);
    assert.equal(observed[1].preflightDecision, returnedDecisions[1]);
    assert.equal(observed[2].preflightDecision, returnedDecisions[1]);
    assert.deepEqual(
      observed.slice(0, 1).map(({ catId, status }) => [catId, status]),
      [['opus', 'succeeded']],
    );
    assert.deepEqual(
      observed
        .slice(1)
        .map(({ catId, status }) => [catId, status])
        .sort(([left], [right]) => left.localeCompare(right)),
      [
        ['codex', 'succeeded'],
        ['opus', 'succeeded'],
      ],
    );
  });

  test('callback queue partitions mixed targets before creating queue entries and returns the complete receipt', async () => {
    const { enqueueA2ATargets } = await import('../dist/routes/callback-a2a-trigger.js');
    const { InvocationQueue } = await import('../dist/domains/cats/services/agents/invocation/InvocationQueue.js');
    const queue = new InvocationQueue();
    const broadcasts = [];
    const result = await enqueueA2ATargets(
      {
        router: {},
        invocationRecordStore: {},
        invocationQueue: queue,
        queueProcessor: { async tryAutoExecute() {} },
        socketManager: {
          broadcastAgentMessage(message, threadId) {
            broadcasts.push({ message, threadId });
          },
          broadcastToRoom() {},
          emitToUser() {},
        },
        routingDispatchPreflight: {
          preflight: async (input) => decision(input, { opus: 'rejected', codex: 'warned' }),
        },
        log: { error() {}, warn() {}, info() {} },
      },
      {
        targetCats: ['opus', 'codex'],
        content: 'review this',
        userId: 'owner-1',
        ownerAuthProvenance: 'unknown',
        threadId: 'thread-callback',
        triggerMessage: {
          id: 'message-callback',
          threadId: 'thread-callback',
          userId: 'owner-1',
          catId: 'terra',
          content: 'review this',
          mentions: ['opus', 'codex'],
          timestamp: Date.now(),
        },
        callerCatId: 'terra',
      },
    );

    assert.deepEqual(result.enqueued, ['codex']);
    assert.deepEqual(
      result.routingPreflight.targets.map(({ targetCatId, disposition }) => ({ targetCatId, disposition })),
      [
        { targetCatId: 'opus', disposition: 'rejected' },
        { targetCatId: 'codex', disposition: 'warned' },
      ],
    );
    assert.deepEqual(
      queue.list('thread-callback', 'owner-1').flatMap((entry) => entry.targetCats),
      ['codex'],
    );
    assert.deepEqual(
      broadcasts
        .filter(({ message }) => message.type === 'system_info' && message.content.includes('routing_preflight'))
        .map(({ message, threadId }) => ({
          threadId,
          target: JSON.parse(message.content).target.targetCatId,
          disposition: JSON.parse(message.content).target.disposition,
        })),
      [
        { threadId: 'thread-callback', target: 'opus', disposition: 'rejected' },
        { threadId: 'thread-callback', target: 'codex', disposition: 'warned' },
      ],
    );
  });
});
