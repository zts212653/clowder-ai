/**
 * F086/F216: the structured PARALLEL path must be visibly and behaviourally distinct from the
 * serial worklist.
 *
 * Requirement 2 of the field report: for an explicit parallel dispatch, every independent target
 * must already hold its own invocation/Queue custody BEFORE any target reaches a terminal, and a
 * partial failure must not block its siblings.
 * Requirement 5: the user-visible projection must distinguish parallel fan-out from serial 第 N/M 棒
 * — before this change the parallel path emitted no routing pill at all, so the ONLY multi-target
 * projection users ever saw was the sequential one.
 */

import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, test } from 'node:test';
import './helpers/setup-cat-registry.js';
import Fastify from 'fastify';
import { InvocationQueue } from '../dist/domains/cats/services/agents/invocation/InvocationQueue.js';
import { registerCallbackAuthHook } from '../dist/routes/callback-auth-prehandler.js';
import { resetMultiMentionOrchestrator } from '../dist/routes/callback-multi-mention-routes.js';

function createMockRegistry() {
  const records = new Map();
  return {
    register(catId, threadId, userId) {
      const id = `inv-${records.size}`;
      const token = `tok-${records.size}`;
      records.set(id, {
        catId,
        threadId,
        userId,
        invocationId: id,
        callbackToken: token,
        ownerAuthProvenance: 'strict',
      });
      return { invocationId: id, callbackToken: token };
    },
    async verify(invocationId, callbackToken) {
      const r = records.get(invocationId);
      if (!r) return { ok: false, reason: 'unknown_invocation' };
      if (r.callbackToken !== callbackToken) return { ok: false, reason: 'invalid_token' };
      return { ok: true, record: r };
    },
    isLatest: () => true,
    claimClientMessageId: () => true,
  };
}

function createMockSocketManager() {
  const messages = [];
  return {
    broadcastAgentMessage(msg, threadId) {
      messages.push({ ...msg, threadId });
    },
    broadcastToRoom() {},
    getMessages: () => messages,
  };
}

function createMockMessageStore() {
  const messages = [];
  return {
    append(msg) {
      const stored = { id: `msg-${messages.length}`, ...msg };
      messages.push(stored);
      return stored;
    },
    getById: (id) => messages.find((m) => m.id === id) ?? null,
    getMessages: () => messages,
  };
}

function createMockQueueProcessor() {
  const hooks = new Map();
  const autoExecuteCalls = [];
  /** Ordered log so "custody happened before any terminal" is observed, not assumed. */
  const timeline = [];
  return {
    timeline,
    registerEntryCompleteHook(entryId, hook) {
      hooks.set(entryId, hook);
      timeline.push(`custody:${entryId}`);
    },
    unregisterEntryCompleteHook(entryId) {
      hooks.delete(entryId);
    },
    tryAutoExecute(threadId) {
      autoExecuteCalls.push(threadId);
      return Promise.resolve();
    },
    getHooks: () => hooks,
    getAutoExecuteCalls: () => autoExecuteCalls,
    simulateComplete(entryId, status, responseText) {
      timeline.push(`terminal:${entryId}`);
      const hook = hooks.get(entryId);
      if (hook) {
        hook(entryId, status, responseText);
        hooks.delete(entryId);
      }
    },
  };
}

describe('F086/F216: explicit parallel fan-out custody + projection', () => {
  let app;
  let mockRegistry, mockSocket, mockMessageStore, invocationQueue, mockQueueProcessor;
  let creds;

  beforeEach(async () => {
    resetMultiMentionOrchestrator();
    mockRegistry = createMockRegistry();
    mockSocket = createMockSocketManager();
    mockMessageStore = createMockMessageStore();
    invocationQueue = new InvocationQueue();
    mockQueueProcessor = createMockQueueProcessor();
    creds = mockRegistry.register('opus', 'thread-par-1', 'user-1');

    app = Fastify({ logger: false });
    registerCallbackAuthHook(app, mockRegistry);
    const { registerMultiMentionRoutes } = await import('../dist/routes/callback-multi-mention-routes.js');
    registerMultiMentionRoutes(app, {
      registry: mockRegistry,
      messageStore: mockMessageStore,
      socketManager: mockSocket,
      router: {
        async *routeExecution() {
          /* queue path must be used */
        },
      },
      invocationRecordStore: { create: () => ({ outcome: 'created', invocationId: 'inv-mm' }), update() {} },
      invocationTracker: {
        start: () => new AbortController(),
        startAll: () => new AbortController(),
        tryStartThreadAll: () => new AbortController(),
        complete() {},
        completeAll() {},
      },
      invocationQueue,
      queueProcessor: mockQueueProcessor,
    });
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
  });

  /**
   * The projection is fire-and-forget by contract (it must never sit in front of start), so any
   * assertion ABOUT the pills has to let those microtasks drain first. Assertions about custody
   * and start deliberately do NOT flush — that is the whole point.
   */
  async function flushProjection() {
    for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r));
  }

  async function dispatchTwoTargets() {
    return app.inject({
      method: 'POST',
      url: '/api/callbacks/multi-mention',
      headers: { 'x-invocation-id': creds.invocationId, 'x-callback-token': creds.callbackToken },
      payload: { targets: ['codex', 'gemini'], question: '独立看一眼', callbackTo: 'opus' },
    });
  }

  test('every target holds Queue custody before ANY target reaches a terminal', async () => {
    const res = await dispatchTwoTargets();
    assert.equal(res.statusCode, 200);

    const entries = invocationQueue.list('thread-par-1', 'user-1');
    const targets = entries.flatMap((e) => e.targetCats);
    assert.deepEqual([...targets].sort(), ['codex', 'gemini'], 'both targets must have their own Queue entry');

    // No terminal has been produced yet, and both custody registrations already happened.
    assert.equal(
      mockQueueProcessor.timeline.filter((t) => t.startsWith('terminal:')).length,
      0,
      'no target may terminate before the fan-out finished admitting siblings',
    );
    assert.equal(mockQueueProcessor.getHooks().size, 2, 'both targets must be tracked independently');

    const firstTerminalIdx = mockQueueProcessor.timeline.findIndex((t) => t.startsWith('terminal:'));
    const custodyCount = mockQueueProcessor.timeline.filter((t) => t.startsWith('custody:')).length;
    assert.equal(custodyCount, 2);
    assert.equal(firstTerminalIdx, -1);
  });

  test('one target failing does not disturb its sibling', async () => {
    await dispatchTwoTargets();
    const entryIds = [...mockQueueProcessor.getHooks().keys()];
    assert.equal(entryIds.length, 2);

    mockQueueProcessor.simulateComplete(entryIds[0], 'failed', undefined);

    assert.ok(mockQueueProcessor.getHooks().has(entryIds[1]), 'sibling custody must survive a partial failure');
    const survivor = invocationQueue
      .list('thread-par-1', 'user-1')
      .find((e) => e.id === entryIds[1] || e.targetCats.includes('gemini'));
    assert.ok(survivor, 'sibling Queue entry must not be evicted by the failed target');
  });

  // ── 砚砚 R1 P1: projection must never run ahead of, or gate, real custody ──────────────
  test('depth-limited targets are NOT projected (projection follows admission, not the request)', async () => {
    // Fill the agent-entry depth budget so the fan-out cannot be admitted.
    for (let i = 0; i < 10; i++) {
      invocationQueue.enqueue({
        threadId: 'thread-par-1',
        userId: 'user-1',
        ownerAuthProvenance: 'strict',
        content: `filler-${i}`,
        source: 'agent',
        targetCats: ['opus'],
        intent: 'execute',
        autoExecute: true,
        callerCatId: 'opus',
      });
    }

    const res = await dispatchTwoTargets();
    assert.equal(res.statusCode, 200);

    const admitted = invocationQueue
      .list('thread-par-1', 'user-1')
      .flatMap((e) => e.targetCats)
      .filter((c) => c === 'codex' || c === 'gemini');
    await flushProjection();
    const pills = mockSocket.getMessages().filter((m) => m.type === 'a2a_handoff');

    assert.equal(admitted.length, 0, 'precondition: depth limit blocked the fan-out');
    assert.equal(
      pills.length,
      0,
      'announcing a fan-out that obtained no custody is exactly the "projection ahead of fact" defect',
    );
  });

  test('a throwing projection writer does not fail an admitted dispatch', async () => {
    let appendCalls = 0;
    mockMessageStore.append = () => {
      appendCalls++;
      throw new Error('projection store is down');
    };

    const res = await dispatchTwoTargets();
    await flushProjection();

    assert.equal(res.statusCode, 200, 'a broken projection must not fail an admitted dispatch');
    assert.ok(appendCalls > 0, 'precondition: the projection writer really was exercised');
    const targets = invocationQueue
      .list('thread-par-1', 'user-1')
      .flatMap((e) => e.targetCats)
      .sort();
    assert.deepEqual(targets, ['codex', 'gemini'], 'custody must survive a projection failure');
    assert.equal(mockQueueProcessor.getHooks().size, 2);
    assert.ok(mockQueueProcessor.getAutoExecuteCalls().length > 0, 'start must still happen');
  });

  test('a NEVER-SETTLING projection writer still lets every admitted sibling start', async () => {
    // 砚砚 R2 P1: the previous test only proved a synchronous throw is survivable. A slow /
    // never-resolving store is the real hazard — with the projection awaited in front of
    // `tryAutoExecute`, every admitted sibling would wait forever for a UI pill.
    let appendCalls = 0;
    mockMessageStore.append = () => {
      appendCalls++;
      return new Promise(() => {
        /* never settles */
      });
    };

    const timedOut = Symbol('timeout');
    const res = await Promise.race([dispatchTwoTargets(), new Promise((r) => setTimeout(() => r(timedOut), 2000))]);

    assert.notStrictEqual(
      res,
      timedOut,
      'the dispatch hung waiting on a projection write — projection is gating start',
    );
    assert.equal(res.statusCode, 200);
    assert.ok(appendCalls > 0, 'precondition: the projection writer really was entered');
    assert.ok(
      mockQueueProcessor.getAutoExecuteCalls().length > 0,
      'start must have happened even though the projection never settled',
    );
    assert.equal(mockQueueProcessor.getHooks().size, 2, 'both siblings keep custody');
  });

  test('a deferred first write does not delay, reorder, or starve the sibling pill', async () => {
    // 砚砚 R3 P1, with an explicit settle latch instead of a fixed number of ticks.
    // Probe that produced the finding: build leg N's timestamp only after leg N-1 persisted, and a
    // slow first write pushes pill2 past the first stream message — the UI then shows the fan-out
    // announcement AFTER the output it announces.
    let releaseFirst;
    const firstWriteEntered = new Promise((resolveEntered) => {
      let entered = false;
      const realAppend = mockMessageStore.append.bind(mockMessageStore);
      mockMessageStore.append = (msg) => {
        if (msg.extra?.systemKind !== 'a2a_routing') return realAppend(msg);
        if (!entered) {
          entered = true;
          resolveEntered();
          return new Promise((resolveWrite) => {
            releaseFirst = () => resolveWrite(realAppend(msg));
          });
        }
        return realAppend(msg);
      };
    });

    const res = await dispatchTwoTargets();
    assert.equal(res.statusCode, 200);
    await firstWriteEntered;

    // The first sibling's write is still in flight. Stamp "the moment the target starts talking".
    const firstStreamTs = Date.now();

    // The SECOND pill must not be waiting behind the first sibling's write.
    await flushProjection();
    const blockedPills = mockSocket.getMessages().filter((m) => m.type === 'a2a_handoff');
    assert.equal(
      blockedPills.length,
      1,
      'the sibling whose write already finished must be broadcast while the other write is pending',
    );
    assert.equal(blockedPills[0].targetCatId, 'gemini');

    releaseFirst();
    await flushProjection();

    const pills = mockSocket.getMessages().filter((m) => m.type === 'a2a_handoff');
    assert.equal(pills.length, 2, 'the deferred write must still produce its pill once it settles');
    for (const pill of pills) {
      assert.ok(
        pill.timestamp <= firstStreamTs,
        `every fan-out pill must be stamped before the announced output starts — ` +
          `pill(${pill.targetCatId})=${pill.timestamp} vs stream=${firstStreamTs}`,
      );
    }
    assert.equal(pills[0].timestamp, pills[1].timestamp, 'a true fan-out starts together — one batch snapshot');
  });

  // ── SAME-CLASS SWEEP (operator-directed): R4 caught the LEGACY path leaving a failed admission
  // unconverged, so the group hung at `partial` until the timeout. The QUEUE path has the same
  // shape and was never probed: `skipped` / `depth_limited` targets only feed the action-lease
  // reconciliation, never `orch.recordResponse`.
  test('a queue target rejected at admission still lets the group terminate', async () => {
    // Pre-occupy gemini's agent slot so its enqueue is skipped as a duplicate.
    invocationQueue.enqueue({
      threadId: 'thread-par-1',
      userId: 'user-1',
      ownerAuthProvenance: 'strict',
      content: 'gemini is already busy',
      source: 'agent',
      targetCats: ['gemini'],
      intent: 'execute',
      autoExecute: true,
      callerCatId: 'opus',
    });

    const res = await dispatchTwoTargets();
    assert.equal(res.statusCode, 200);
    await flushProjection();

    const pills = mockSocket.getMessages().filter((m) => m.type === 'a2a_handoff');
    assert.deepEqual(
      pills.map((p) => p.targetCatId),
      ['codex'],
      'precondition: only codex was admitted',
    );

    // codex answers; gemini never will, because it never got custody.
    const codexEntry = [...mockQueueProcessor.getHooks().keys()][0];
    mockQueueProcessor.simulateComplete(codexEntry, 'succeeded', 'codex reply');
    await flushProjection();

    const aggregated = mockMessageStore.getMessages().find((m) => m.content?.includes('Multi-Mention 结果汇总'));
    assert.ok(
      aggregated,
      'the group must reach done/flush on its own — a target rejected at admission can never ' +
        'produce a response, so leaving it pending strands the initiator on the timeout timer',
    );
    assert.match(aggregated.content, /codex reply/);
  });

  test('partial admission: only the target that really got custody is projected', async () => {
    // 9 fillers → first target takes the 10th slot, second hits MAX_MM_DEPTH.
    for (let i = 0; i < 9; i++) {
      invocationQueue.enqueue({
        threadId: 'thread-par-1',
        userId: 'user-1',
        ownerAuthProvenance: 'strict',
        content: `filler-${i}`,
        source: 'agent',
        targetCats: ['opus'],
        intent: 'execute',
        autoExecute: true,
        callerCatId: 'opus',
      });
    }

    const res = await dispatchTwoTargets();
    assert.equal(res.statusCode, 200);
    await flushProjection();

    const admitted = invocationQueue
      .list('thread-par-1', 'user-1')
      .flatMap((e) => e.targetCats)
      .filter((c) => c === 'codex' || c === 'gemini');
    assert.deepEqual(admitted, ['codex'], 'precondition: exactly one target cleared the depth budget');

    const pills = mockSocket.getMessages().filter((m) => m.type === 'a2a_handoff');
    assert.equal(pills.length, 1, 'the depth-limited sibling must not be announced');
    assert.equal(pills[0].targetCatId, 'codex');
    assert.deepEqual(
      { mode: pills[0].routing.mode, index: pills[0].routing.index, total: pills[0].routing.total },
      { mode: 'parallel', index: 1, total: 1 },
      'index/total must describe the ADMITTED group, not the requested one',
    );
    // A fan-out that admitted exactly one target IS a single dispatch, so the label keeps the
    // plain single-target shape — adding "（并行 1/1）" would invent a group that does not exist.
    // The structured field still carries the mode for machine consumers.
    assert.equal(pills[0].content, '布偶猫(opus) → 缅因猫(codex)');
    assert.doesNotMatch(pills[0].content, /串行|排队中/, 'a lone admitted target must not read as a queued serial leg');
  });

  test('custody is established before the fan-out is projected', async () => {
    const order = [];
    const realAppend = mockMessageStore.append.bind(mockMessageStore);
    mockMessageStore.append = (msg) => {
      if (msg.extra?.systemKind === 'a2a_routing') order.push('projection');
      return realAppend(msg);
    };
    const realRegister = mockQueueProcessor.registerEntryCompleteHook.bind(mockQueueProcessor);
    mockQueueProcessor.registerEntryCompleteHook = (entryId, hook) => {
      order.push('custody');
      return realRegister(entryId, hook);
    };

    await dispatchTwoTargets();
    await flushProjection();

    assert.deepEqual(
      order,
      ['custody', 'custody', 'projection', 'projection'],
      `every target must hold custody before anything is announced — got ${order.join(',')}`,
    );
  });

  test('parallel fan-out projects a PARALLEL pill, distinct from a serial leg', async () => {
    await dispatchTwoTargets();
    await flushProjection();

    const pills = mockSocket.getMessages().filter((m) => m.type === 'a2a_handoff');
    assert.equal(pills.length, 2, 'a real fan-out must be announced, not left invisible');

    for (const pill of pills) {
      assert.ok(pill.routing, 'pill must carry the structured mode');
      assert.equal(pill.routing.mode, 'parallel');
      assert.equal(pill.routing.total, 2);
      assert.match(pill.content, /并行 \d\/2/);
      assert.doesNotMatch(pill.content, /串行/, 'a fan-out must never render as a serial leg');
    }
    assert.deepEqual(
      pills.map((p) => p.targetCatId).sort(),
      ['codex', 'gemini'],
      'every fanned-out target gets its own projection',
    );

    // History must project the same truth as the live stream (reload parity).
    const persisted = mockMessageStore.getMessages().filter((m) => m.extra?.systemKind === 'a2a_routing');
    assert.equal(persisted.length, 2);
    for (const m of persisted) {
      assert.equal(m.extra.a2aRouting.routing.mode, 'parallel');
    }
  });
});

/**
 * 砚砚 R2 P1: the legacy direct-dispatch fallback (no InvocationQueue) has NO observable admission
 * point — `dispatchToTarget` is fire-and-forget and still returns without custody when the tracker
 * slot is already aborted or the invocation record is a duplicate. So `admitted === requested` is
 * false there, and the honest terminal state is to project nothing rather than to draw a pill for a
 * target that may never get an invocation. Absence is not a lie; a false arrow is (#1291).
 */
describe('F086/F216: legacy fan-out is two-phase (admit all → project admitted → start)', () => {
  let app;
  let mockRegistry, mockSocket, mockMessageStore, mockRouter, creds;
  let createOutcome, createInvocation, startedTargets, recordUpdates, releasedSlots, updateImpl;

  beforeEach(async () => {
    resetMultiMentionOrchestrator();
    mockRegistry = createMockRegistry();
    mockSocket = createMockSocketManager();
    mockMessageStore = createMockMessageStore();
    const executions = [];
    startedTargets = { onStart: undefined };
    mockRouter = {
      // biome-ignore lint/correctness/useYield: legacy path only needs an async iterable
      async *routeExecution(_userId, _message, _threadId, _invId, targetCats) {
        startedTargets.onStart?.(targetCats[0]);
        executions.push({ targetCats });
      },
      getExecutions: () => executions,
    };
    createOutcome = 'created';
    recordUpdates = [];
    releasedSlots = [];
    updateImpl = (id, patch) => recordUpdates.push({ id, ...patch });
    let seq = 0;
    createInvocation = (_input) => ({ outcome: createOutcome, invocationId: `inv-legacy-${seq++}` });
    creds = mockRegistry.register('opus', 'thread-legacy-1', 'user-1');

    app = Fastify({ logger: false });
    registerCallbackAuthHook(app, mockRegistry);
    const { registerMultiMentionRoutes } = await import('../dist/routes/callback-multi-mention-routes.js');
    registerMultiMentionRoutes(app, {
      registry: mockRegistry,
      messageStore: mockMessageStore,
      socketManager: mockSocket,
      router: mockRouter,
      invocationRecordStore: {
        create: (input) => createInvocation(input),
        update: (id, patch) => updateImpl(id, patch),
      },
      invocationTracker: {
        start: () => new AbortController(),
        startAll: () => new AbortController(),
        tryStartThreadAll: () => new AbortController(),
        complete(_threadId, catId) {
          releasedSlots.push(catId);
        },
        completeAll() {},
      },
      // NO invocationQueue / queueProcessor → legacy fallback
    });
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
  });

  async function dispatchTwoTargets() {
    const res = await app.inject({
      method: 'POST',
      url: '/api/callbacks/multi-mention',
      headers: { 'x-invocation-id': creds.invocationId, 'x-callback-token': creds.callbackToken },
      payload: { targets: ['codex', 'gemini'], question: '独立看一眼', callbackTo: 'opus' },
    });
    for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r));
    return res;
  }

  test('every legacy sibling is admitted before ANY of them starts', async () => {
    // The discriminating shape: make the SECOND target's admission slow. With admission
    // interleaved inside each fire-and-forget dispatch (the old code), the fast target starts
    // while its sibling still has no invocation — requirement 2 violated. A sync mock would let
    // both admissions finish first by luck and make this test pass either way (a false green),
    // so the delay is what gives it discriminating power.
    const order = [];
    const realCreate = createInvocation;
    createInvocation = async (input) => {
      const catId = input.targetCats[0];
      if (catId === 'gemini') {
        for (let i = 0; i < 3; i++) await new Promise((r) => setImmediate(r));
      }
      order.push(`admit:${catId}`);
      return realCreate(input);
    };
    startedTargets.onStart = (catId) => order.push(`start:${catId}`);

    const res = await dispatchTwoTargets();
    assert.equal(res.statusCode, 200);
    for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r));

    const admits = order.filter((o) => o.startsWith('admit:'));
    assert.equal(admits.length, 2, 'both targets must be admitted');
    const firstStart = order.findIndex((o) => o.startsWith('start:'));
    assert.notEqual(firstStart, -1, 'precondition: at least one target actually started');
    assert.equal(
      order.slice(0, firstStart).filter((o) => o.startsWith('admit:')).length,
      2,
      `all siblings must hold custody before the first start — got ${order.join(',')}`,
    );
  });

  test('a target that drops out during admission is never announced', async () => {
    createOutcome = 'duplicate';
    const res = await dispatchTwoTargets();
    assert.equal(res.statusCode, 200);

    const pills = mockSocket.getMessages().filter((m) => m.type === 'a2a_handoff');
    assert.equal(pills.length, 0, 'duplicate targets never get an invocation — they must not be drawn');
    const persisted = mockMessageStore.getMessages().filter((m) => m.extra?.systemKind === 'a2a_routing');
    assert.equal(persisted.length, 0, 'and nothing phantom may reach durable history either');
    assert.equal(mockRouter.getExecutions().length, 0, 'nor may an unadmitted target be started');
  });

  test('admission failing AFTER record create converges the record and settles the group', async () => {
    // 砚砚 R4 P1, reproduced from his fault injection: make codex's `queued → running` update throw.
    // Extracting admission out of `dispatchToTarget` moved the happy path but left that function's
    // catch behind, so the created record was orphaned at `queued`, no failure response was
    // registered, and the group sat at `partial` until the timeout.
    const realUpdate = (id, patch) => recordUpdates.push({ id, ...patch });
    let failedInvocationId;
    const originalCreate = createInvocation;
    createInvocation = (input) => {
      const result = originalCreate(input);
      if (input.targetCats[0] === 'codex') failedInvocationId = result.invocationId;
      return result;
    };
    updateImpl = (id, patch) => {
      if (id === failedInvocationId && patch.status === 'running') throw new Error('running update failed');
      return realUpdate(id, patch);
    };

    const res = await dispatchTwoTargets();
    assert.equal(res.statusCode, 200);
    for (let i = 0; i < 8; i++) await new Promise((r) => setImmediate(r));

    // 1. the orphaned record is converged, not left at `queued`
    const converged = recordUpdates.find((u) => u.id === failedInvocationId && u.status !== 'running');
    assert.ok(converged, `record ${failedInvocationId} must be converged, got ${JSON.stringify(recordUpdates)}`);
    assert.ok(['failed', 'canceled'].includes(converged.status));

    // 2. the tracker slot is released
    assert.ok(releasedSlots.includes('codex'), 'the failed target must release its tracker slot');

    // 3. the sibling is untouched and really runs
    assert.deepEqual(
      mockRouter.getExecutions().map((e) => e.targetCats[0]),
      ['gemini'],
      'a failed admission must not disturb its sibling',
    );

    // 4. the failure is registered so the group can terminate on its own
    const aggregated = mockMessageStore.getMessages().find((m) => m.content?.includes('Multi-Mention 结果汇总'));
    assert.ok(aggregated, 'the group must reach done/flush without waiting for the timeout timer');
    assert.match(
      aggregated.content,
      /admission error|失败/,
      'the failed target must be reported, not silently dropped',
    );

    // 5. only the admitted sibling is projected
    const pills = mockSocket.getMessages().filter((m) => m.type === 'a2a_handoff');
    assert.deepEqual(
      pills.map((p) => p.targetCatId),
      ['gemini'],
    );
  });

  test('admitted legacy siblings still get a PARALLEL projection', async () => {
    const res = await dispatchTwoTargets();
    assert.equal(res.statusCode, 200);

    const pills = mockSocket.getMessages().filter((m) => m.type === 'a2a_handoff');
    assert.equal(pills.length, 2, 'requirement 5 applies to the legacy path too once admission is observable');
    for (const pill of pills) {
      assert.equal(pill.routing.mode, 'parallel');
      assert.equal(pill.routing.total, 2);
    }
  });

  test('single-target legacy dispatch still works (no fan-out contract to violate)', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/callbacks/multi-mention',
      headers: { 'x-invocation-id': creds.invocationId, 'x-callback-token': creds.callbackToken },
      payload: { targets: ['codex'], question: '单独看一眼', callbackTo: 'opus' },
    });
    for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r));

    assert.equal(res.statusCode, 200, 'single-target legacy dispatch must not be collateral damage');
    assert.equal(mockRouter.getExecutions().length, 1);
    const pills = mockSocket.getMessages().filter((m) => m.type === 'a2a_handoff');
    assert.equal(pills.length, 1);
    assert.equal(pills[0].routing.total, 1, 'a lone target is its own group');
  });
});
