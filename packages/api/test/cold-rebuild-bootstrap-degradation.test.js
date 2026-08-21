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
 *      targets degrading independently against one empty chain
 *      (route-parallel.ts).
 *   3. remedial — rebuildRemedialPromptAfterSessionSeal degrades to the bare
 *      remedial prompt (route-serial.ts stop-gate remedial child).
 *
 * Per-sibling observability (PR #1375 review finding): every assertion is
 * per-cat, never aggregate. An earlier revision shared ONE provider session
 * id between both siblings; the second cat's runtime binding then conflicted
 * (SessionChainStore cliSessionId uniqueness) and it silently took the
 * no-prior 'fresh' branch instead of the cold-rebuild handshake — shared
 * counters let the first sibling's evidence satisfy the second sibling's
 * assertions (vacuous pass). Now:
 *   - sessionManager.get returns a per-cat session id, so BOTH siblings
 *     genuinely hit the cold-rebuild handshake;
 *   - countingChain buckets getChain reads per catId;
 *   - completion / error / prompt / degradation-warning assertions are
 *     filtered per catId, and each sibling's bounded degradation warning is
 *     asserted to fire exactly once, attributed to that sibling.
 *
 * Mechanics shared by all cases: the mock service reports
 * {provider: 'openai', carrier: 'exec_json'} → resolveProviderCarrier maps to
 * codex/exec_json → supportsPreProviderContinuityHandshake is true; the mock
 * sessionManager returns an active per-cat provider session id → handshake
 * disposition.state === 'unknown' → invokeSingleCat cold-rebuild branch calls
 * params.rebuildPromptAfterSessionSeal(). The SessionChainStore is real but
 * EMPTY (no sealed, no sealing, no active record) — the exact Session #1
 * shape — so buildSessionBootstrap returns null on every rebuild.
 */

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { catRegistry } from '@cat-cafe/shared';

const { SessionChainStore } = await import('../dist/domains/cats/services/stores/ports/SessionChainStore.js');

// --- Bounded degradation-warning capture -----------------------------------
// pino children carry their own level methods (child.warn !== root.warn), so
// patching the root logger does NOT intercept module loggers. Instead, wrap
// logger.child BEFORE the route modules load (they are dynamically imported
// inside each test) and record every child by module name, then wrap the
// captured child's warn itself.
const { logger } = await import('../dist/infrastructure/logger.js');
const moduleLoggers = new Map();
const originalModuleWarns = new Map();
{
  const originalChild = logger.child.bind(logger);
  logger.child = (bindings) => {
    const child = originalChild(bindings);
    if (bindings && typeof bindings.module === 'string') {
      moduleLoggers.set(bindings.module, child);
    }
    return child;
  };
}

/** Collect the module logger's warn(...) calls from now on (re-entrant reset). */
function captureWarns(moduleName) {
  const child = moduleLoggers.get(moduleName);
  const warns = [];
  if (!child) {
    return warns;
  }
  if (!originalModuleWarns.has(moduleName)) {
    originalModuleWarns.set(moduleName, child.warn.bind(child));
  }
  const originalWarn = originalModuleWarns.get(moduleName);
  child.warn = (...args) => {
    warns.push(args);
    return originalWarn(...args);
  };
  return warns;
}

function countDegradationWarnings(warns, { catId, message }) {
  return warns.filter(([fields, msg]) => fields?.catId === catId && msg === message).length;
}

const SERIAL_DEGRADED_MESSAGE =
  '[routeSerial] session bootstrap rebuild returned no sealed prior; degrading to initial bootstrap context';
const PARALLEL_DEGRADED_MESSAGE =
  '[routeParallel] session bootstrap rebuild returned no sealed prior; degrading to initial bootstrap context';
const REMEDIAL_DEGRADED_MESSAGE =
  '[routeSerial] remedial session bootstrap rebuild returned no sealed prior; degrading to bare remedial prompt';

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

/**
 * Count getChain reads PER CAT so a test can prove each cat's own rebuild ran
 * (initial bootstrap read + at least one rebuild read for that same catId).
 */
function countingChain(store) {
  const callsByCat = new Map();
  const wrapper = Object.create(Object.getPrototypeOf(store), Object.getOwnPropertyDescriptors(store));
  wrapper.getChain = (catId, ...args) => {
    callsByCat.set(catId, (callsByCat.get(catId) ?? 0) + 1);
    return store.getChain(catId, ...args);
  };
  wrapper.getChainCalls = (catId) => callsByCat.get(catId) ?? 0;
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
        // PER-CAT provider session id. A shared id would make the second
        // sibling's bindManagedSessionRuntimeId conflict on the
        // SessionChainStore cliSessionId uniqueness and silently drop it to
        // the no-prior 'fresh' branch — exactly the vacuous-pass shape the
        // review asked us to make impossible.
        get: async (_userId, catId) => `cli-session-${catId}`,
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

/**
 * Per-cat degradation contract. Every check is filtered to this catId, so no
 * sibling's chain reads, messages, or prompts can stand in for another's.
 */
function assertDegradedInvocations({ yielded, service, catId, getChainCalls }) {
  // This cat's rebuild really ran: initial bootstrap read + rebuild read.
  assert.ok(
    getChainCalls(catId) >= 2,
    `${catId}'s rebuild must re-query the chain (getChain calls: ${getChainCalls(catId)})`,
  );
  // Per-cat messages only — the pre-fix contract failed here with
  // `sealed_session_bootstrap_unavailable`.
  const own = yielded.filter((message) => message.catId === catId);
  const errorMessages = own.filter(
    (message) => message.type === 'error' || message.error === true || message.isError === true,
  );
  assert.deepEqual(
    errorMessages.map((message) => message.content ?? message.error),
    [],
    `Session #1 cold-rebuild must not fail ${catId}'s invocation`,
  );
  assert.ok(
    own.some((message) => message.type === 'done'),
    `${catId}'s invocation must complete`,
  );
  // Degradation shape: no sealed prior → no [Session Continuity] block in
  // any prompt this cat received.
  for (const prompt of service.calls) {
    assert.doesNotMatch(prompt, /\[Session Continuity/, `${catId} has no prior to inject`);
  }
}

describe('cold-rebuild bootstrap degradation (Session #1, no sealed prior)', () => {
  test('serial: cold-rebuild handshake degrades to the initial prompt instead of failing', async () => {
    const { routeSerial } = await import('../dist/domains/cats/services/agents/routing/route-serial.js');
    const warns = captureWarns('route-serial');
    const service = createHandshakeService('codex', ['serial answer']);
    const { yielded, deps } = await runRoute(routeSerial, { codex: service }, 'thread-cold-rebuild-serial');
    assertDegradedInvocations({
      yielded,
      service,
      catId: 'codex',
      getChainCalls: deps.invocationDeps.sessionChainStore.getChainCalls,
    });
    assert.equal(service.calls.length, 1, 'serial routes exactly one invocation');
    assert.match(service.calls[0], /cold rebuild probe/, 'degraded prompt still carries the user message');
    assert.equal(
      countDegradationWarnings(warns, { catId: 'codex', message: SERIAL_DEGRADED_MESSAGE }),
      1,
      'exactly one bounded degradation warning',
    );
  });

  test('parallel siblings: concurrent cats each degrade independently instead of failing', async () => {
    const { routeParallel } = await import('../dist/domains/cats/services/agents/routing/route-parallel.js');
    const warns = captureWarns('route-parallel');
    // Two concurrent targets share one empty chain read window — both hit the
    // cold-rebuild handshake at the same time (the fan-out sibling shape).
    const codex = createHandshakeService('codex', ['codex answer']);
    const claude = createHandshakeService('claude', ['claude answer']);
    const { yielded, deps } = await runRoute(routeParallel, { codex, claude }, 'thread-cold-rebuild-parallel', {
      targetCats: ['codex', 'claude'],
    });
    for (const [catId, service] of [
      ['codex', codex],
      ['claude', claude],
    ]) {
      assertDegradedInvocations({
        yielded,
        service,
        catId,
        getChainCalls: deps.invocationDeps.sessionChainStore.getChainCalls,
      });
      // Exactly one invocation per sibling — no shared prompt, no cross-sibling
      // leakage: each service only ever saw its own degraded prompt.
      assert.equal(service.calls.length, 1, `${catId} routes exactly one invocation`);
      assert.match(service.calls[0], /cold rebuild probe/, `${catId}'s degraded prompt still carries the user message`);
      assert.equal(
        countDegradationWarnings(warns, { catId, message: PARALLEL_DEGRADED_MESSAGE }),
        1,
        `exactly one bounded degradation warning attributed to ${catId}`,
      );
    }
  });

  test('remedial: stop-gate remedial child degrades to the bare remedial prompt instead of failing', async () => {
    const { routeSerial } = await import('../dist/domains/cats/services/agents/routing/route-serial.js');
    const warns = captureWarns('route-serial');
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
      catId: 'codex',
      getChainCalls: deps.invocationDeps.sessionChainStore.getChainCalls,
    });
    assert.equal(service.calls.length, 2, 'main child + one remedial child');
    // The remedial child keeps its fixed custody prompt (bare, no bootstrap
    // prefix) — the degraded rebuild returns turnCustodyRemedialPrompt itself.
    assert.match(service.calls[1], /F167 球权停止门/, 'remedial child keeps the stop-gate prompt');
    // Main rebuild AND remedial rebuild each degrade exactly once — bounded,
    // one warning per rebuild, both attributed to the invoking cat.
    assert.equal(
      countDegradationWarnings(warns, { catId: 'codex', message: SERIAL_DEGRADED_MESSAGE }),
      1,
      'main rebuild warns exactly once',
    );
    assert.equal(
      countDegradationWarnings(warns, { catId: 'codex', message: REMEDIAL_DEGRADED_MESSAGE }),
      1,
      'remedial rebuild warns exactly once',
    );
  });
});
