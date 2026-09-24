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
  test('serial and parallel classify human attempts from strict ingress, preserving queued origin', async () => {
    const { routeSerial } = await import('../dist/domains/cats/services/agents/routing/route-serial.js');
    const { routeParallel } = await import('../dist/domains/cats/services/agents/routing/route-parallel.js');
    for (const route of [routeSerial, routeParallel]) {
      for (const [origin, queueSource, auth, expected] of [
        ['direct_owner', undefined, 'strict', true],
        ['queue_replay', 'user', 'strict', true],
        ['queue_replay', 'agent', 'strict', false],
        ['queue_replay', 'connector', 'strict', false],
        ['callback', 'user', 'strict', false],
        ['direct_owner', undefined, 'unknown', false],
      ]) {
        const seen = [];
        const deps = routeDeps(
          {},
          {
            preflight: async (input) => {
              seen.push(input);
              return decision(input, { opus: 'rejected' });
            },
          },
        );
        for await (const _event of route(deps, ['opus'], 'request', 'owner-1', 'origin-thread', {
          ownerAuthProvenance: auth,
          humanDispositionInvocationOrigin: origin,
          routingQueueSource: queueSource,
        })) {
          /* drain real route */
        }
        assert.equal(
          seen[0].ownerRequestedAttempt === true,
          expected,
          `${route.name}: ${origin}/${queueSource}/${auth}`,
        );
      }
    }
  });

  test('all rejected targets produce truthful failed dispositions without any child invocation', async () => {
    const { routeSerial } = await import('../dist/domains/cats/services/agents/routing/route-serial.js');
    const { routeParallel } = await import('../dist/domains/cats/services/agents/routing/route-parallel.js');
    const { PerCatTerminalDispositionCollector } = await import(
      '../dist/domains/cats/services/agents/invocation/PerCatTerminalDispositionCollector.js'
    );
    for (const route of [routeSerial, routeParallel]) {
      const calls = [];
      const collector = new PerCatTerminalDispositionCollector({ targetCatIds: ['opus', 'codex'] });
      const deps = routeDeps(
        { opus: service('opus', calls), codex: service('codex', calls) },
        { preflight: async (input) => decision(input, { opus: 'rejected', codex: 'rejected' }) },
      );
      for await (const event of route(deps, ['opus', 'codex'], 'request', 'owner-1', 'rejected-thread'))
        collector.observe(event);
      assert.equal(calls.length, 0, `${route.name} must not start a rejected child invocation: ${calls.join(',')}`);
      assert.deepEqual(collector.getSuccessfulCatIds(), []);
      assert.ok(collector.getPrimaryTerminalError(), `${route.name} must expose a retryable failure`);
    }
  });

  test('a rejected original request persists its exact retry source for refresh and thread switching', async () => {
    const { routeSerial } = await import('../dist/domains/cats/services/agents/routing/route-serial.js');
    const stored = [];
    const deps = routeDeps({}, { preflight: async (input) => decision(input, { opus: 'rejected' }) });
    deps.messageStore.append = async (input) => {
      const message = { ...input, id: `notice-${stored.length}` };
      stored.push(message);
      return message;
    };
    const emitted = [];
    for await (const event of routeSerial(deps, ['opus'], 'original', 'owner-1', 'thread-1', {
      parentInvocationId: 'parent-1',
      currentUserMessageId: 'message-1',
    }))
      emitted.push(event);
    const notice = stored.find((message) => message.extra?.systemInfo?.payload.type === 'routing_preflight');
    assert.ok(notice, 'the notice must survive hydration');
    assert.equal(notice.extra.systemInfo.payload.retryInvocationId, 'parent-1');
    assert.equal(notice.extra.systemInfo.payload.sourceMessageId, 'message-1');
    assert.equal(emitted.find((event) => event.type === 'system_info')?.messageId, notice.id);
  });

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
      !receipts.some((receipt) => receipt.target.targetCatId === 'codex'),
      'fail-open infrastructure degradation stays in routing telemetry instead of becoming chat content',
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
    assert.equal(
      events.filter((event) => event.type === 'system_info' && event.content?.includes('routing_preflight')).length,
      0,
      'an unavailable advisory resolver must not manufacture a visible warning for an unchanged send',
    );
  });

  test('completed response preflights before atomic ledger admission and leaves no rejected row', async () => {
    const { commitCompletedResponseAndEnqueueA2ATargets } = await import('../dist/routes/callback-a2a-trigger.js');
    const { InvocationQueue } = await import('../dist/domains/cats/services/agents/invocation/InvocationQueue.js');
    const { MessageStore } = await import('../dist/domains/cats/services/stores/ports/MessageStore.js');
    const queue = new InvocationQueue();
    const messageStore = new MessageStore();
    const broadcasts = [];
    const processing = messageStore.append({
      from: { kind: 'agent', catId: 'opus' },
      threadId: 'thread-deferred',
      userId: 'owner-1',
      content: '',
      mentions: [],
      origin: 'stream',
      timestamp: 100,
      lifecycle: {
        kind: 'response',
        orderKey: '0000000000100:response-opus',
        from: { kind: 'agent', catId: 'opus' },
        invocationId: 'inv-opus',
        targetId: 'opus',
        inputEntryIds: ['entry-source'],
        inputMessageIds: ['message-source'],
        status: 'processing',
        startedAt: 100,
      },
    });
    const stored = await commitCompletedResponseAndEnqueueA2ATargets(
      {
        invocationQueue: queue,
        messageStore,
        queueProcessor: { async requestDrain() {} },
        socketManager: {
          broadcastAgentMessage(message, threadId) {
            broadcasts.push({ message, threadId });
          },
          emitToUser() {},
        },
        routingDispatchPreflight: {
          preflight: async (input) => decision(input, { codex: 'rejected', terra: 'warned' }),
        },
        log: { error() {}, warn() {}, info() {} },
      },
      {
        responseMessageId: processing.id,
        invocationId: 'inv-opus',
        terminal: { status: 'completed', completedAt: 200 },
        message: {
          from: { kind: 'agent', catId: 'opus' },
          threadId: 'thread-deferred',
          userId: 'owner-1',
          content: '@codex\n@terra\ncontinue from here',
          mentions: ['codex', 'terra'],
          origin: 'stream',
          timestamp: 200,
        },
        targetCats: ['codex', 'terra'],
        userId: 'owner-1',
        ownerAuthProvenance: 'unknown',
        threadId: 'thread-deferred',
        callerCatId: 'opus',
      },
    );

    assert.equal(stored.lifecycle.status, 'completed');
    assert.deepEqual(
      queue.list('thread-deferred', 'owner-1').flatMap((entry) => entry.targets),
      ['terra'],
    );
    assert.ok(
      broadcasts.some(
        ({ message }) =>
          message.type === 'system_info' &&
          message.content?.includes('routing_preflight') &&
          JSON.parse(message.content).target.targetCatId === 'codex',
      ),
    );
  });

  test('failed A2A response atomically admits one idempotent Queue-only wake for the exact caller', async () => {
    const { commitFailedResponseAndEnqueueA2ACaller } = await import('../dist/routes/callback-a2a-trigger.js');
    const { InvocationQueue } = await import('../dist/domains/cats/services/agents/invocation/InvocationQueue.js');
    const { MessageStore } = await import('../dist/domains/cats/services/stores/ports/MessageStore.js');
    const queue = new InvocationQueue();
    const messageStore = new MessageStore();
    const processing = messageStore.append({
      from: { kind: 'agent', catId: 'codex' },
      threadId: 'thread-failed-a2a',
      userId: 'owner-1',
      content: '',
      mentions: [],
      origin: 'stream',
      timestamp: 100,
      lifecycle: {
        kind: 'response',
        orderKey: '0000000000100:response-codex',
        from: { kind: 'agent', catId: 'codex' },
        invocationId: 'inv-codex',
        targetId: 'codex',
        inputEntryIds: ['entry-source'],
        inputMessageIds: ['message-source'],
        status: 'processing',
        startedAt: 100,
      },
    });
    const observedBusinessDispatches = [];
    const deps = {
      invocationQueue: queue,
      messageStore,
      queueProcessor: {
        async requestDrain() {},
        registerCallerDispatchInitialTargets(source, targets) {
          observedBusinessDispatches.push({ sourceId: source.id, targets });
        },
      },
      socketManager: { broadcastAgentMessage() {}, emitToUser() {} },
      log: { error() {}, warn() {}, info() {} },
    };
    const input = {
      responseMessageId: processing.id,
      invocationId: 'inv-codex',
      terminal: { status: 'failed', completedAt: 200, reason: 'model_not_found' },
      message: {
        from: { kind: 'agent', catId: 'codex' },
        threadId: 'thread-failed-a2a',
        userId: 'owner-1',
        content: 'configured model unavailable',
        mentions: [],
        origin: 'stream',
        timestamp: 200,
      },
      userId: 'owner-1',
      ownerAuthProvenance: 'strict',
      threadId: 'thread-failed-a2a',
      reporterCatId: 'codex',
      predecessorCatId: 'fable',
    };

    await commitFailedResponseAndEnqueueA2ACaller(deps, input);
    await commitFailedResponseAndEnqueueA2ACaller(deps, input);

    const failed = messageStore.getById(processing.id);
    assert.equal(failed.lifecycle.status, 'failed');
    assert.equal(failed.content, 'configured model unavailable');
    const rows = queue.list('thread-failed-a2a', 'owner-1');
    assert.equal(rows.length, 1);
    assert.equal(rows[0].sourceCategory, 'a2a_failure');
    assert.deepEqual(rows[0].targets, ['fable']);
    assert.equal(rows[0].payload.messageId, processing.id);
    assert.deepEqual(
      observedBusinessDispatches,
      [],
      'the failure control edge is not a new outbound business dispatch by the reporter',
    );
    assert.equal(
      messageStore.getByThread('thread-failed-a2a', 100, 'owner-1').filter((message) => message.id === processing.id)
        .length,
      1,
      'the Queue control carrier must not create a second public failure result',
    );
  });

  test('parallel mixed targets never invoke the rejected child', async () => {
    const { routeParallel } = await import('../dist/domains/cats/services/agents/routing/route-parallel.js');
    const calls = [];
    const deps = routeDeps(
      { opus: service('opus', calls), codex: service('codex', calls) },
      { preflight: async (input) => decision(input, { opus: 'rejected', codex: 'warned' }) },
    );
    const events = [];
    for await (const event of routeParallel(deps, ['opus', 'codex'], 'ideate', 'owner-1', 'thread-parallel')) {
      events.push(event);
    }

    assert.ok(!calls.includes('opus'));
    assert.ok(calls.includes('codex'));
    const receipts = events
      .filter((event) => event.type === 'system_info' && event.content?.includes('routing_preflight'))
      .map((event) => JSON.parse(event.content));
    assert.deepEqual(
      receipts.map((receipt) => [receipt.target.targetCatId, receipt.target.disposition]),
      [['opus', 'rejected']],
      'parallel fail-open degradation stays in routing telemetry instead of becoming chat content',
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
    const { MessageStore } = await import('../dist/domains/cats/services/stores/ports/MessageStore.js');
    const queue = new InvocationQueue();
    const messageStore = new MessageStore();
    const broadcasts = [];
    const triggerMessage = messageStore.append({
      from: { kind: 'agent', catId: 'terra' },
      threadId: 'thread-callback',
      userId: 'owner-1',
      content: 'review this',
      mentions: ['opus', 'codex'],
      origin: 'callback',
      timestamp: Date.now(),
    });
    const result = await enqueueA2ATargets(
      {
        invocationQueue: queue,
        messageStore,
        queueProcessor: { async requestDrain() {} },
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
        triggerMessage,
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
      queue.list('thread-callback', 'owner-1').flatMap((entry) => entry.targets),
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
      [{ threadId: 'thread-callback', target: 'opus', disposition: 'rejected' }],
    );
  });
});
