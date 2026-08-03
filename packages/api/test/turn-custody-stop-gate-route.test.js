/**
 * F167 Phase T cutover — routeSerial consumes turn-scoped custody truth.
 *
 * These fixtures intentionally do not grade reply text. The authoritative
 * inputs are wake provenance, projection transitions, verified eventWait state,
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
        shouldBlock: next.shouldBlock,
        transitionObserved: next.transitionObserved,
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
            intent: 'review',
            eventWait: {
              v: 1,
              invocationId: 'outer-inv-1',
              threadId,
              ownerCatId: 'codex',
              subjectKey: 'pr:zts212653/cat-cafe#3282',
              expectedSignal: 'review_posted',
              coverage: {
                status: 'covered',
                kind: 'github_review_trigger_eyes',
                triggerCommentId: 4_936_000_000,
                observedAt: 1_783_700_000_000,
              },
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
  { triggerMessage, taskStore, turnCustodyProjectionService, turnExecutionStore, metadataAugments } = {},
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
        resolveWorkingDirectory: () => '/tmp/test',
      },
      threadStore: null,
      apiUrl: 'http://127.0.0.1:3004',
      ...(taskStore ? { taskStore } : {}),
      ...(turnExecutionStore ? { turnExecutionStore } : {}),
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
  { projectionService, routeOptions = {}, taskStore, triggerMessage, turnExecutionStore } = {},
) {
  return withCatRegistryLock(async () => {
    const original = catRegistry.getAllConfigs();
    const { loadCatConfig, toAllCatConfigs } = await import('../dist/config/cat-config-loader.js');
    const { routeSerial } = await import('../dist/domains/cats/services/agents/routing/route-serial.js');
    catRegistry.reset();
    for (const [id, config] of Object.entries(toAllCatConfigs(loadCatConfig()))) {
      catRegistry.register(id, config);
    }
    const appended = [];
    const metadataAugments = [];
    try {
      const deps = createMockDeps(service, appended, {
        turnCustodyProjectionService: projectionService,
        taskStore,
        triggerMessage,
        turnExecutionStore,
        metadataAugments,
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

  test('verified eventWait is a structured transition and suppresses the remedial child', async () => {
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
