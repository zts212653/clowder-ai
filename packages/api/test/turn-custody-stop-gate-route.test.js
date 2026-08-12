/**
 * F167 Phase T cutover — routeSerial consumes turn-scoped custody truth.
 *
 * These fixtures intentionally do not grade reply text. The authoritative
 * inputs are wake provenance, projection transitions, a verified typed PR wait,
 * and durable child-execution records.
 */

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { catRegistry } from '@cat-cafe/shared';

let catRegistryLock = Promise.resolve();

async function withCatRegistryLock(fn) {
  const previous = catRegistryLock;
  let release;
  catRegistryLock = new Promise((resolve) => {
    release = resolve;
  });
  await previous;
  try {
    return await fn();
  } finally {
    release();
  }
}

function createSequenceService(catId, turns) {
  const calls = [];
  return {
    calls,
    async *invoke(prompt) {
      calls.push(prompt);
      const turn = turns[Math.min(calls.length - 1, turns.length - 1)] ?? '';
      yield {
        type: 'system_info',
        catId,
        content: JSON.stringify({ type: 'invocation_created', invocationId: `${catId}-inv-${calls.length}` }),
        timestamp: Date.now(),
      };
      const events = Array.isArray(turn) ? turn : [{ type: 'text', content: turn }];
      for (const event of events) {
        yield { catId, timestamp: Date.now(), ...event };
      }
      yield { type: 'done', catId, timestamp: Date.now() };
    },
  };
}

function createProjectionService({ state, closeDecisions }) {
  const opens = [];
  const closes = [];
  return {
    opens,
    closes,
    async open(wake) {
      opens.push(wake);
      return {
        state,
        evidenceRefs: [`wake:${wake.kind}`],
        ...(state === 'covered_active' ? { baseline: { kind: 'test' } } : {}),
      };
    },
    async close(projection) {
      const next = closeDecisions[Math.min(closes.length, closeDecisions.length - 1)];
      const decision = {
        state,
        ...next,
        evidenceRefs: [...projection.evidenceRefs],
      };
      closes.push(decision);
      return decision;
    },
  };
}

function createEventWaitTaskStore(threadId) {
  return {
    async listByThread() {
      return [
        {
          id: 'task-event-wait',
          kind: 'pr_tracking',
          threadId,
          subjectKey: 'pr:zts212653/cat-cafe#3282',
          title: 'Review tracking',
          ownerCatId: 'codex',
          status: 'doing',
          why: 'waiting for exact-head review',
          createdBy: 'codex',
          createdAt: 1,
          updatedAt: 2,
          automationState: {
            await: {
              v: 1,
              generation: 1,
              subjectRef: 'pr:zts212653/cat-cafe#3282',
              ownerFence: { kind: 'containing_task', generation: 1 },
              baseline: {
                capturedAt: 1_783_700_000_000,
                headSha: 'head-1',
                review: { resultTriggerCommentId: 4_936_000_000 },
              },
              continuation: {
                when: [{ kind: 'pr_review_result_available', triggerCommentId: 4_936_000_000 }],
                // biome-ignore lint/suspicious/noThenProperty: F280's frozen wait contract field.
                then: 'Consume the exact-HEAD review result.',
              },
              expiresAt: 1_883_700_000_000,
              createdAt: 1_783_700_000_000,
              provenance: 'explicit_registration',
            },
          },
        },
      ];
    },
  };
}

function createMockDeps(
  service,
  appended,
  {
    triggerMessage,
    taskStore,
    turnCustodyProjectionService,
    turnExecutionStore,
    metadataAugments,
    sessionChainStore,
    sessionSealer,
    transcriptReader,
    sessionManager,
  } = {},
) {
  let sequence = 0;
  return {
    services: { codex: service },
    invocationDeps: {
      registry: {
        create: () => ({ invocationId: `outer-inv-${++sequence}`, callbackToken: `tok-${sequence}` }),
        verify: async () => ({ ok: false, reason: 'unknown_invocation' }),
      },
      sessionManager: {
        getOrCreate: async () => ({}),
        get: async () => null,
        delete: async () => {},
        resolveWorkingDirectory: () => '/tmp/test',
        ...sessionManager,
      },
      threadStore: null,
      apiUrl: 'http://127.0.0.1:3004',
      ...(taskStore ? { taskStore } : {}),
      ...(turnExecutionStore ? { turnExecutionStore } : {}),
      ...(sessionChainStore ? { sessionChainStore } : {}),
      ...(sessionSealer ? { sessionSealer } : {}),
      ...(transcriptReader ? { transcriptReader } : {}),
    },
    messageStore: {
      append: async (message) => {
        const stored = {
          id: `stored-${++sequence}`,
          userId: message.userId ?? '',
          catId: message.catId ?? null,
          content: message.content ?? '',
          mentions: message.mentions ?? [],
          timestamp: message.timestamp ?? 0,
          source: message.source,
          origin: message.origin,
          mentionsUser: message.mentionsUser,
          toolEvents: message.toolEvents,
          extra: message.extra,
        };
        appended.push(stored);
        return stored;
      },
      getById: async (messageId) => (messageId === triggerMessage?.id ? triggerMessage : null),
      getRecent: async () => [],
      getMentionsFor: async () => [],
      getBefore: async () => [],
      getByThread: async () => [],
      getByThreadAfter: async () => [],
      getByThreadBefore: async () => [],
      augmentStreamMetadata: async (messageId, patch) => {
        metadataAugments.push({ messageId, patch });
        return true;
      },
    },
    draftStore: {
      upsert: () => {},
      touch: () => {},
      delete: async () => {},
      deleteByThread: () => {},
      getByThread: () => [],
    },
    socketManager: { broadcastToRoom: () => {} },
    ...(taskStore ? { taskStore } : {}),
    turnCustodyProjectionService,
  };
}

async function runRoute(
  service,
  threadId,
  {
    projectionService,
    routeOptions = {},
    taskStore,
    triggerMessage,
    turnExecutionStore,
    beforeRoute,
    sessionChainStore,
    sessionSealer,
    transcriptReader,
    sessionManager,
  } = {},
) {
  return withCatRegistryLock(async () => {
    const original = catRegistry.getAllConfigs();
    const { loadCatConfig, toAllCatConfigs } = await import('../dist/config/cat-config-loader.js');
    const { routeSerial } = await import('../dist/domains/cats/services/agents/routing/route-serial.js');
    catRegistry.reset();
    for (const [id, config] of Object.entries(toAllCatConfigs(loadCatConfig()))) {
      catRegistry.register(id, config);
    }
    beforeRoute?.();
    const appended = [];
    const metadataAugments = [];
    try {
      const deps = createMockDeps(service, appended, {
        turnCustodyProjectionService: projectionService,
        taskStore,
        triggerMessage,
        turnExecutionStore,
        metadataAugments,
        sessionChainStore,
        sessionSealer,
        transcriptReader,
        sessionManager,
      });
      const yielded = [];
      for await (const message of routeSerial(deps, ['codex'], 'custody gate test', 'user1', threadId, {
        invocationController: new AbortController(),
        trackA2ASlot: () => true,
        completeA2ASlots: () => {},
        ...routeOptions,
      })) {
        yielded.push(message);
      }
      return { appended, yielded, metadataAugments };
    } finally {
      catRegistry.reset();
      for (const [id, config] of Object.entries(original)) {
        catRegistry.register(id, config);
      }
    }
  });
}

describe('F167 Phase T route custody stop gate', () => {
  test('covered_empty naturally stops without manufacturing a routing outlet', async () => {
    const projection = createProjectionService({
      state: 'covered_empty',
      closeDecisions: [{ shouldBlock: false, transitionObserved: false }],
    });
    const service = createSequenceService('codex', ['Ordinary answer with no protocol ball.']);

    const { appended } = await runRoute(service, 'thread-covered-empty', {
      projectionService: projection,
      routeOptions: { turnCustodyWake: { kind: 'unstructured', source: 'user_chat' } },
    });

    assert.equal(service.calls.length, 1);
    assert.equal(projection.closes.length, 1);
    assert.equal(
      appended.some((message) => message.source?.connector === 'routing-guard-failure'),
      false,
    );
  });

  test('covered_active without a transition runs one structured remedial child and stops retrying', async () => {
    const projection = createProjectionService({
      state: 'covered_active',
      closeDecisions: [
        { shouldBlock: true, transitionObserved: false },
        { shouldBlock: true, transitionObserved: false },
      ],
    });
    const service = createSequenceService('codex', ['Text-only completion.', '@co-creator']);

    const { appended, yielded } = await runRoute(service, 'thread-covered-active-blocked', {
      projectionService: projection,
      routeOptions: {
        turnCustodyWake: {
          kind: 'action_successor',
          leaseId: 'lease-1',
          generation: 1,
          holderCatId: 'codex',
        },
      },
    });

    assert.equal(service.calls.length, 2);
    assert.match(service.calls[1], /结构化/);
    assert.match(service.calls[1], /不要用纯文本/);
    assert.equal(projection.closes.length, 2);
    assert.equal(appended.filter((message) => message.source?.connector === 'routing-guard-failure').length, 1);
    assert.equal(
      yielded.some((message) => message.type === 'a2a_handoff' || message.mentionsUser),
      false,
      'remedial prose and line-start mentions are not structured custody transitions',
    );
  });

  test('managed hold mounts its disposition producer on the exact turn and fails without a second invocation', async () => {
    const projection = createProjectionService({
      state: 'covered_active',
      closeDecisions: [{ shouldBlock: true, transitionObserved: false }],
    });
    const service = createSequenceService('codex', ['Text-only completion.']);

    const { appended, yielded } = await runRoute(service, 'thread-managed-hold-remedial', {
      projectionService: projection,
      routeOptions: {
        turnCustodyWake: {
          kind: 'structured',
          protocol: 'hold',
          subjectKey: 'ball:thread:thread-managed-hold-remedial',
          holderCatId: 'codex',
          sourceMessageId: 'message-managed-hold',
          taskId: 'task-managed-hold',
        },
      },
    });

    assert.equal(service.calls.length, 1);
    assert.match(service.calls[0], /cat_cafe_complete_managed_hold/);
    assert.doesNotMatch(service.calls[0], /完成候选/);
    assert.doesNotMatch(service.calls[0], /returnToPredecessor/);
    assert.match(service.calls[0], /command exit/);
    assert.equal(projection.closes.length, 1);
    assert.equal(appended.filter((message) => message.source?.connector === 'routing-guard-failure').length, 1);
    assert.equal(yielded.find((message) => message.type === 'done')?.errorCode, 'managed_hold_disposition_missing');
  });

  test('ordinary A2A dispatch mounts its exact producer and never spawns a stale remedial child', async () => {
    const projection = createProjectionService({
      state: 'covered_active',
      closeDecisions: [{ shouldBlock: true, transitionObserved: false }],
    });
    const service = createSequenceService('codex', ['Completed the requested review.']);

    const { appended, yielded } = await runRoute(service, 'thread-a2a-dispatch-disposition', {
      projectionService: projection,
      routeOptions: {
        turnCustodyWake: {
          kind: 'structured',
          protocol: 'dispatch',
          subjectKey: 'ball:thread:thread-a2a-dispatch-disposition',
          holderCatId: 'codex',
          handoff: {
            sourceEventId: 'route:message-a2a:codex',
            messageId: 'message-a2a',
            fromCatId: 'fable5',
          },
        },
      },
    });

    assert.equal(service.calls.length, 1);
    assert.match(service.calls[0], /cat_cafe_complete_a2a_dispatch/);
    assert.doesNotMatch(service.calls[0], /完成候选/);
    assert.doesNotMatch(service.calls[0], /returnToPredecessor/);
    assert.match(service.calls[0], /merge truth/);
    assert.equal(projection.closes.length, 1);
    assert.equal(appended.filter((message) => message.source?.connector === 'routing-guard-failure').length, 1);
    assert.equal(yielded.find((message) => message.type === 'done')?.errorCode, 'a2a_dispatch_disposition_missing');
  });

  test('managed re-hold emits exact continuation receipt proof without terminal completion', async () => {
    const projection = createProjectionService({
      state: 'covered_active',
      closeDecisions: [{ shouldBlock: false, transitionObserved: true, structuredTransitionKind: 'held' }],
    });
    const service = createSequenceService('codex', ['Established a new structured hold.']);

    const { yielded } = await runRoute(service, 'thread-managed-hold-continued', {
      projectionService: projection,
      routeOptions: {
        turnCustodyWake: {
          kind: 'structured',
          protocol: 'hold',
          subjectKey: 'ball:thread:thread-managed-hold-continued',
          holderCatId: 'codex',
          sourceMessageId: 'message-managed-hold',
          taskId: 'task-managed-hold',
        },
      },
    });

    assert.deepEqual(yielded.find((message) => message.type === 'done')?.turnCustodyTerminalWitness, {
      kind: 'managed_hold_continued',
      sourceMessageId: 'message-managed-hold',
      taskId: 'task-managed-hold',
      transition: 'reheld',
    });
  });

  test('managed transfer emits exact continuation receipt proof', async () => {
    const projection = createProjectionService({
      state: 'covered_active',
      closeDecisions: [{ shouldBlock: false, transitionObserved: true, structuredTransitionKind: 'handed' }],
    });
    const service = createSequenceService('codex', ['Transferred through a structured action.']);

    const { yielded } = await runRoute(service, 'thread-managed-hold-transferred', {
      projectionService: projection,
      routeOptions: {
        turnCustodyWake: {
          kind: 'structured',
          protocol: 'hold',
          subjectKey: 'ball:thread:thread-managed-hold-transferred',
          holderCatId: 'codex',
          sourceMessageId: 'message-managed-hold',
          taskId: 'task-managed-hold',
        },
      },
    });

    assert.equal(
      yielded.find((message) => message.type === 'done')?.turnCustodyTerminalWitness?.transition,
      'transferred',
    );
  });

  test('managed eventWait emits exact continuation receipt proof', async () => {
    const threadId = 'thread-managed-hold-event-wait';
    const projection = createProjectionService({
      state: 'covered_active',
      closeDecisions: [{ shouldBlock: true, transitionObserved: false }],
    });
    const service = createSequenceService('codex', ['Registered the exact event wait.']);

    const { yielded } = await runRoute(service, threadId, {
      projectionService: projection,
      taskStore: createEventWaitTaskStore(threadId),
      routeOptions: {
        turnCustodyWake: {
          kind: 'structured',
          protocol: 'hold',
          subjectKey: `ball:thread:${threadId}`,
          holderCatId: 'codex',
          sourceMessageId: 'message-managed-hold',
          taskId: 'task-managed-hold',
        },
      },
    });

    assert.equal(
      yielded.find((message) => message.type === 'done')?.turnCustodyTerminalWitness?.transition,
      'event_wait',
    );
  });

  test('a structured remedial transition closes the same projection without a failure notice', async () => {
    const projection = createProjectionService({
      state: 'covered_active',
      closeDecisions: [
        { shouldBlock: true, transitionObserved: false },
        { shouldBlock: false, transitionObserved: true },
      ],
    });
    const service = createSequenceService('codex', ['Text-only completion.', 'Structured tool completed.']);

    const { appended } = await runRoute(service, 'thread-covered-active-repaired', {
      projectionService: projection,
      routeOptions: {
        turnCustodyWake: {
          kind: 'action_successor',
          leaseId: 'lease-2',
          generation: 1,
          holderCatId: 'codex',
        },
      },
    });

    assert.equal(service.calls.length, 2);
    assert.equal(projection.closes.length, 2);
    assert.equal(
      appended.some((message) => message.source?.connector === 'routing-guard-failure'),
      false,
    );
  });

  test('the stop-gate remedial child reads a fresh member capacity snapshot', async () => {
    const replaceCodexWindow = (contextWindow) => {
      const configs = catRegistry.getAllConfigs();
      catRegistry.reset();
      for (const [id, config] of Object.entries(configs)) {
        catRegistry.register(id, id === 'codex' ? { ...config, contextWindow } : config);
      }
    };
    const calls = [];
    const service = {
      async *invoke(prompt, options) {
        calls.push({ prompt, capacity: options?.contextCapacity });
        if (calls.length === 1) replaceCodexWindow(256_000);
        yield {
          type: 'system_info',
          catId: 'codex',
          content: JSON.stringify({ type: 'invocation_created', invocationId: `codex-capacity-${calls.length}` }),
          timestamp: Date.now(),
        };
        yield { type: 'text', catId: 'codex', content: 'No structured transition.', timestamp: Date.now() };
        yield { type: 'done', catId: 'codex', timestamp: Date.now() };
      },
    };
    const projection = createProjectionService({
      state: 'covered_active',
      closeDecisions: [
        { shouldBlock: true, transitionObserved: false },
        { shouldBlock: true, transitionObserved: false },
      ],
    });

    await runRoute(service, 'thread-remedial-capacity', {
      projectionService: projection,
      beforeRoute: () => replaceCodexWindow(1_000_000),
      routeOptions: {
        turnCustodyWake: {
          kind: 'action_successor',
          leaseId: 'lease-remedial-capacity',
          generation: 1,
          holderCatId: 'codex',
        },
      },
    });

    assert.equal(calls.length, 2);
    assert.equal(calls[0].capacity?.windowTokens, 1_000_000);
    assert.equal(calls[1].capacity?.windowTokens, 256_000);
  });

  test('the stop-gate remedial child rebuilds its fixed prompt after a fresh capacity seal', async () => {
    const { SessionChainStore } = await import('../dist/domains/cats/services/stores/ports/SessionChainStore.js');
    const { _setTestStrategyOverride, _clearTestStrategyOverrides, getSessionStrategyWithSource } = await import(
      '../dist/config/session-strategy.js'
    );
    const sessionChainStore = new SessionChainStore();
    const threadId = 'thread-remedial-capacity-seal';
    const active = sessionChainStore.create({
      cliSessionId: 'cli-remedial-capacity-old',
      threadId,
      catId: 'codex',
      userId: 'user1',
    });
    sessionChainStore.update(active.id, {
      contextHealth: {
        usedTokens: 240_000,
        windowTokens: 2_000_000,
        fillRatio: 0.12,
        source: 'exact',
        usedFrom: 'last_turn',
        measuredAt: Date.now(),
      },
    });
    const replaceCodexWindow = (contextWindow) => {
      const configs = catRegistry.getAllConfigs();
      catRegistry.reset();
      for (const [id, config] of Object.entries(configs)) {
        catRegistry.register(id, id === 'codex' ? { ...config, contextWindow } : config);
      }
    };
    const prompts = [];
    const service = {
      contextCapability() {
        return {
          provider: 'openai',
          carrier: 'test_stream',
          reportsRuntimeWindow: false,
          authoritativeUsage: true,
          usageTelemetry: 'available',
          nativeWindowControl: false,
          nativeCompressionControl: false,
          observesCompression: true,
          reason: 'test carrier',
        };
      },
      async *invoke(prompt) {
        prompts.push(prompt);
        if (prompts.length === 1) replaceCodexWindow(256_000);
        yield {
          type: 'system_info',
          catId: 'codex',
          content: JSON.stringify({ type: 'invocation_created', invocationId: `codex-seal-${prompts.length}` }),
          timestamp: Date.now(),
        };
        yield { type: 'text', catId: 'codex', content: 'No structured transition.', timestamp: Date.now() };
        yield { type: 'done', catId: 'codex', timestamp: Date.now() };
      },
    };
    const sessionSealer = {
      async requestSeal({ sessionId, reason }) {
        sessionChainStore.update(sessionId, { status: 'sealing', sealReason: reason });
        return { accepted: true, status: 'sealing', sessionId };
      },
      async finalize({ sessionId }) {
        sessionChainStore.update(sessionId, { status: 'sealed' });
      },
    };
    const projection = createProjectionService({
      state: 'covered_active',
      closeDecisions: [
        { shouldBlock: true, transitionObserved: false },
        { shouldBlock: true, transitionObserved: false },
      ],
    });

    try {
      await runRoute(service, threadId, {
        projectionService: projection,
        beforeRoute: () => {
          _setTestStrategyOverride('codex', {
            strategy: 'hybrid',
            thresholds: { warn: 0.75, action: 0.85 },
            turnBudget: 12_000,
            safetyMargin: 4_000,
            hybrid: { maxCompressions: 1 },
          });
          const policy = getSessionStrategyWithSource('codex');
          sessionChainStore.update(active.id, {
            appliedPolicy: {
              config: policy.effective,
              source: policy.source,
              revision: policy.revision,
              changedAt: policy.changedAt,
              execution: { status: 'active', missingCapabilities: [] },
            },
            hybridProgress: {
              policyRevision: policy.revision,
              observedCount: 1,
              startedAt: new Date().toISOString(),
            },
          });
          replaceCodexWindow(2_000_000);
        },
        sessionChainStore,
        sessionSealer,
        transcriptReader: { readDigest: async () => null },
        sessionManager: { get: async () => 'cli-remedial-capacity-old' },
        routeOptions: {
          turnCustodyWake: {
            kind: 'action_successor',
            leaseId: 'lease-remedial-capacity-seal',
            generation: 1,
            holderCatId: 'codex',
          },
        },
      });
    } finally {
      _clearTestStrategyOverrides();
    }

    assert.equal(prompts.length, 2);
    assert.match(prompts[1], /\[Session Continuity/);
    assert.match(prompts[1], /F167 球权停止门/);
  });

  test('verified typed PR wait is a structured transition and suppresses the remedial child', async () => {
    const threadId = 'thread-event-wait';
    const projection = createProjectionService({
      state: 'covered_active',
      closeDecisions: [{ shouldBlock: true, transitionObserved: false }],
    });
    const service = createSequenceService('codex', ['Waiting for the registered review callback.']);

    await runRoute(service, threadId, {
      projectionService: projection,
      taskStore: createEventWaitTaskStore(threadId),
      routeOptions: {
        turnCustodyWake: {
          kind: 'action_successor',
          leaseId: 'lease-review',
          generation: 1,
          holderCatId: 'codex',
        },
      },
    });

    assert.equal(service.calls.length, 1);
    assert.equal(projection.closes.length, 1);
  });

  test('terminal coordination release remains obligation-free', async () => {
    const threadId = 'thread-terminal-release';
    const triggerMessage = {
      id: 'msg-terminal-release',
      threadId,
      catId: 'opus',
      content: 'Release complete.',
      extra: {
        crossPost: {
          sourceThreadId: 'thread-source',
          senderCatId: 'opus',
          effectClass: 'coordinate',
          coordination: { id: 'coord-1', phase: 'terminal', hop: 2 },
        },
      },
    };
    const projection = createProjectionService({
      state: 'covered_empty',
      closeDecisions: [{ shouldBlock: false, transitionObserved: false }],
    });
    const service = createSequenceService('codex', [[]]);

    const { yielded } = await runRoute(service, threadId, {
      projectionService: projection,
      triggerMessage,
      routeOptions: {
        currentUserMessageId: triggerMessage.id,
        turnCustodyWake: {
          kind: 'structured',
          protocol: 'dispatch',
          subjectKey: `ball:thread:${threadId}`,
          holderCatId: 'codex',
          handoff: {
            sourceEventId: 'message:msg-terminal-release:to:codex',
            messageId: triggerMessage.id,
            fromCatId: 'opus',
          },
        },
      },
    });

    assert.equal(service.calls.length, 1);
    assert.deepEqual(projection.opens[0], {
      kind: 'non_obligation',
      source: 'coordination_terminal',
    });
    const terminal = yielded.find((message) => message.type === 'done');
    assert.deepEqual(terminal.turnCustodyTerminalWitness, {
      kind: 'terminal_silent',
      projectionState: 'covered_empty',
      wake: 'coordination_terminal',
    });
  });

  test('ordinary and stop-gate remedial invocations retain separate durable child truth', async () => {
    const { InMemoryTurnExecutionStore } = await import(
      '../dist/domains/cats/services/stores/memory/InMemoryTurnExecutionStore.js'
    );
    const turnExecutionStore = new InMemoryTurnExecutionStore();
    const projection = createProjectionService({
      state: 'covered_active',
      closeDecisions: [
        { shouldBlock: true, transitionObserved: false },
        { shouldBlock: false, transitionObserved: true },
      ],
    });
    const service = createSequenceService('codex', ['Original answer.', 'Structured transition complete.']);

    const { metadataAugments } = await runRoute(service, 'thread-child-truth', {
      projectionService: projection,
      turnExecutionStore,
      routeOptions: {
        parentInvocationId: 'parent-stop-gate',
        currentUserMessageId: 'msg-trigger',
        turnCustodyWake: {
          kind: 'action_successor',
          leaseId: 'lease-child-truth',
          generation: 1,
          holderCatId: 'codex',
        },
      },
    });

    assert.deepEqual(
      (await turnExecutionStore.listByParent('parent-stop-gate')).map((record) => ({
        executionKind: record.executionKind,
        status: record.status,
        routingGuardReason: record.causal?.routingGuardReason,
      })),
      [
        { executionKind: 'ordinary', status: 'succeeded', routingGuardReason: undefined },
        { executionKind: 'routing_guard', status: 'succeeded', routingGuardReason: 'missing_routing_exit' },
      ],
    );
    assert.ok(
      metadataAugments.some((entry) =>
        entry.patch.extra?.auxiliaryTurnExecutions?.some((execution) => execution.executionKind === 'routing_guard'),
      ),
      'persisted visible output must point to the structured remedial child',
    );
  });
});
