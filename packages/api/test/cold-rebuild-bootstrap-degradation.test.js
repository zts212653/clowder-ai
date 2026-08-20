/**
 * Session #1 cold-rebuild bootstrap degradation — serial / parallel / remedial.
 *
 * buildSessionBootstrap returns null when the chain has NO sealed/sealing
 * prior (Session #1 — SessionBootstrap.ts "no prior context to inject").
 * The pre-fix rebuild paths treated that null as fatal
 * (`sealed_session_bootstrap_unavailable`), so the very invocation that could
 * seal Session #1 was permanently blocked whenever it hit the cold-rebuild
 * handshake (codex/exec_json carrier + active provider session): a
 * deterministic chicken-and-egg loop (production observation 2026-08-19,
 * thread_mrqb0yfauece1tmm, ~20h with no self-heal).
 *
 * These tests pin the degradation contract on all three rebuild paths:
 *   1. serial   — rebuildPromptAfterSessionSeal degrades to the initial
 *      bootstrap context (route-serial.ts).
 *   2. parallel siblings — same contract on the concurrent path, with two
 *      targets degrading independently against one empty chain (route-parallel.ts).
 *   3. remedial — rebuildRemedialPromptAfterSessionSeal degrades to the bare
 *      remedial prompt (route-serial.ts stop-gate remedial child).
 *
 * Mechanics shared by all cases: the mock service reports
 * {provider: 'openai', carrier: 'exec_json'} → resolveProviderCarrier maps to
 * codex/exec_json → supportsPreProviderContinuityHandshake is true; the mock
 * sessionManager returns an active provider session id → handshake
 * disposition.state === 'unknown' → invokeSingleCat cold-rebuild branch calls
 * params.rebuildPromptAfterSessionSeal(). The SessionChainStore is real but
 * EMPTY (no sealed, no sealing, no active record) — the exact Session #1
 * shape — so buildSessionBootstrap returns null on every rebuild.
 */

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { catRegistry } from '@cat-cafe/shared';

const { SessionChainStore } = await import('../dist/domains/cats/services/stores/ports/SessionChainStore.js');

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

/** codex/exec_json carrier + prompt-recording invoke generator. */
function createHandshakeService(catId, turns) {
  const calls = [];
  return {
    calls,
    contextCapability() {
      return {
        provider: 'openai',
        carrier: 'exec_json',
        reportsRuntimeWindow: true,
        authoritativeUsage: false,
        usageTelemetry: 'available',
        nativeWindowControl: true,
        nativeCompressionControl: false,
        observesCompression: true,
        reason: 'test carrier',
      };
    },
    async *invoke(prompt) {
      calls.push(prompt);
      yield {
        type: 'system_info',
        catId,
        content: JSON.stringify({ type: 'invocation_created', invocationId: `${catId}-inv-${calls.length}` }),
        timestamp: Date.now(),
      };
      const turn = turns[Math.min(calls.length - 1, turns.length - 1)] ?? '';
      const events = Array.isArray(turn) ? turn : [{ type: 'text', content: turn }];
      for (const event of events) {
        yield { catId, timestamp: Date.now(), ...event };
      }
      yield { type: 'done', catId, timestamp: Date.now() };
    },
  };
}

/** Count getChain calls so a test can PROVE the rebuild actually ran. */
function countingChain(store) {
  let getChainCalls = 0;
  const wrapper = Object.create(Object.getPrototypeOf(store), Object.getOwnPropertyDescriptors(store));
  wrapper.getChain = (...args) => {
    getChainCalls += 1;
    return store.getChain(...args);
  };
  wrapper.getChainCalls = () => getChainCalls;
  return wrapper;
}

function createProjectionService({ state, closeDecisions }) {
  const closes = [];
  return {
    closes,
    async open() {
      return {
        state,
        evidenceRefs: [`wake:test`],
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

function createMockDeps(
  services,
  appended,
  { turnCustodyProjectionService, sessionChainStore, sessionSealer, transcriptReader, sessionManager } = {},
) {
  let sequence = 0;
  return {
    services,
    invocationDeps: {
      registry: {
        create: () => ({ invocationId: `outer-inv-${++sequence}`, callbackToken: `tok-${sequence}` }),
        verify: async () => ({ ok: false, reason: 'unknown_invocation' }),
      },
      sessionManager: {
        getOrCreate: async () => ({}),
        // Non-null provider session id → handshake requestedRuntimeSessionId →
        // disposition.state 'unknown' (signal_unavailable) → cold-rebuild.
        get: async () => 'cli-session-1',
        delete: async () => {},
        resolveWorkingDirectory: () => '/tmp/test',
        ...sessionManager,
      },
      threadStore: null,
      apiUrl: 'http://127.0.0.1:3004',
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
      getById: async () => null,
      getRecent: async () => [],
      getMentionsFor: async () => [],
      getBefore: async () => [],
      getByThread: async () => [],
      getByThreadAfter: async () => [],
      getByThreadBefore: async () => [],
      augmentStreamMetadata: async () => true,
    },
    draftStore: {
      upsert: () => {},
      touch: () => {},
      delete: async () => {},
      deleteByThread: () => {},
      getByThread: () => [],
    },
    socketManager: { broadcastToRoom: () => {} },
    turnCustodyProjectionService,
  };
}

async function runRoute(
  route,
  services,
  threadId,
  { targetCats = ['codex'], projectionService, routeOptions = {} } = {},
) {
  return withCatRegistryLock(async () => {
    const original = catRegistry.getAllConfigs();
    const { loadCatConfig, toAllCatConfigs } = await import('../dist/config/cat-config-loader.js');
    catRegistry.reset();
    for (const [id, config] of Object.entries(toAllCatConfigs(loadCatConfig()))) {
      catRegistry.register(id, config);
    }
    const appended = [];
    try {
      const deps = createMockDeps(services, appended, {
        turnCustodyProjectionService: projectionService,
        // REAL store, ZERO records — the Session #1 / no-sealed-prior shape.
        sessionChainStore: countingChain(new SessionChainStore()),
        sessionSealer: {
          async requestSeal() {
            return { accepted: false, status: 'rejected', sessionId: 'seal-none' };
          },
          async finalize() {},
        },
        transcriptReader: { readDigest: async () => null },
      });
      const yielded = [];
      for await (const message of route(deps, targetCats, 'cold rebuild probe', 'user1', threadId, {
        invocationController: new AbortController(),
        trackA2ASlot: () => true,
        completeA2ASlots: () => {},
        ...routeOptions,
      })) {
        yielded.push(message);
      }
      return { appended, yielded, deps };
    } finally {
      catRegistry.reset();
      for (const [id, config] of Object.entries(original)) {
        catRegistry.register(id, config);
      }
    }
  });
}

function assertDegradedInvocations({ yielded, service, getChainCalls }) {
  // The rebuild really ran: initial bootstrap read + at least one rebuild read.
  assert.ok(getChainCalls() >= 2, `rebuild must re-query the chain (getChain calls: ${getChainCalls()})`);
  // No invocation error — the pre-fix contract failed here with
  // `sealed_session_bootstrap_unavailable`.
  const errorMessages = yielded.filter(
    (message) => message.type === 'error' || message.error === true || message.isError === true,
  );
  assert.deepEqual(
    errorMessages.map((message) => message.content ?? message.error),
    [],
    'Session #1 cold-rebuild must not fail the invocation',
  );
  assert.ok(
    yielded.some((message) => message.type === 'done'),
    'invocation must complete',
  );
  // Degradation shape: no sealed prior → no [Session Continuity] block.
  for (const prompt of service.calls) {
    assert.doesNotMatch(prompt, /\[Session Continuity/, 'Session #1 has no prior to inject');
  }
}

describe('cold-rebuild bootstrap degradation (Session #1, no sealed prior)', () => {
  test('serial: cold-rebuild handshake degrades to the initial prompt instead of failing', async () => {
    const { routeSerial } = await import('../dist/domains/cats/services/agents/routing/route-serial.js');
    const service = createHandshakeService('codex', ['serial answer']);
    const { yielded, deps } = await runRoute(routeSerial, { codex: service }, 'thread-cold-rebuild-serial');
    assertDegradedInvocations({
      yielded,
      service,
      getChainCalls: deps.invocationDeps.sessionChainStore.getChainCalls,
    });
    assert.equal(service.calls.length, 1, 'serial routes exactly one invocation');
    assert.match(service.calls[0], /cold rebuild probe/, 'degraded prompt still carries the user message');
  });

  test('parallel siblings: concurrent cats each degrade independently instead of failing', async () => {
    const { routeParallel } = await import('../dist/domains/cats/services/agents/routing/route-parallel.js');
    // Two concurrent targets share one empty chain read window — both hit the
    // cold-rebuild handshake at the same time (the fan-out sibling shape).
    const codex = createHandshakeService('codex', ['codex answer']);
    const claude = createHandshakeService('claude', ['claude answer']);
    const { yielded, deps } = await runRoute(routeParallel, { codex, claude }, 'thread-cold-rebuild-parallel', {
      targetCats: ['codex', 'claude'],
    });
    for (const service of [codex, claude]) {
      assertDegradedInvocations({
        yielded,
        service,
        getChainCalls: deps.invocationDeps.sessionChainStore.getChainCalls,
      });
      assert.equal(service.calls.length, 1, 'each parallel sibling routes exactly one invocation');
      assert.match(service.calls[0], /cold rebuild probe/, 'degraded prompt still carries the user message');
    }
  });

  test('remedial: stop-gate remedial child degrades to the bare remedial prompt instead of failing', async () => {
    const { routeSerial } = await import('../dist/domains/cats/services/agents/routing/route-serial.js');
    // First close blocks with no structured transition → one remedial child.
    const projection = createProjectionService({
      state: 'covered_active',
      closeDecisions: [{ shouldBlock: true, transitionObserved: false }],
    });
    const service = createHandshakeService('codex', ['No structured transition.', 'remedial answer']);
    const { yielded, deps } = await runRoute(routeSerial, { codex: service }, 'thread-cold-rebuild-remedial', {
      projectionService: projection,
      routeOptions: {
        turnCustodyWake: {
          kind: 'action_successor',
          leaseId: 'lease-cold-rebuild-remedial',
          generation: 1,
          holderCatId: 'codex',
        },
      },
    });
    assertDegradedInvocations({
      yielded,
      service,
      getChainCalls: deps.invocationDeps.sessionChainStore.getChainCalls,
    });
    assert.equal(service.calls.length, 2, 'main child + one remedial child');
    // The remedial child keeps its fixed custody prompt (bare, no bootstrap
    // prefix) — the degraded rebuild returns turnCustodyRemedialPrompt itself.
    assert.match(service.calls[1], /F167 球权停止门/, 'remedial child keeps the stop-gate prompt');
  });
});
