/**
 * Regression: 并发 @ 多只猫，取消一只误伤/漏伤另一只（铲屎官报告 2026-05-30）
 *
 * 现象：并发 @codex 和 @gpt52，点击取消 codex → 两只猫一起被取消。
 *
 * Root cause: InvocationTracker.startAll 给每只猫独立 AbortController（注释明写
 * "per-cat cancel safe"），但只 RETURN primaryController（catIds[0] 的 controller）。
 * 执行层（QueueProcessor:961 → AgentRouter.routeExecution → route-parallel:426）
 * 把这单一 primaryController.signal 传给 EVERY cat 监听。于是：
 *   - 取消第一只（= primary）→ abort primaryController → 所有猫一起死
 *     （铲屎官复现：并发 @codex+@gpt52，取消 codex → 两只一起取消）
 *   - 取消非第一只 → abort 一个没人监听的 controller → 那只猫继续跑（取消无效）
 *
 * Fix: route-parallel 必须给每只猫各自的 slot signal —— options.signalForCat(catId)。
 *
 * RED on current code（route-parallel 忽略 signalForCat，所有猫共享 options.signal）。
 * GREEN after route-parallel reads per-cat signalForCat。
 *
 * 可观测点：mock service.invoke(prompt, options) 捕获每只猫执行时收到的 options.signal
 * （invoke-single-cat.ts:483 callerSignal → 517 AbortSignal.any → 967 options.signal
 *  → 2106 service.invoke(prompt, options)）。
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

const { routeParallel } = await import('../dist/domains/cats/services/agents/routing/route-parallel.js');
const { routeSerial } = await import('../dist/domains/cats/services/agents/routing/route-serial.js');
const { InvocationTracker } = await import('../dist/domains/cats/services/agents/invocation/InvocationTracker.js');

function makeCapturingService(catId, captured) {
  return {
    async *invoke(_prompt, options) {
      captured[catId] = options?.signal;
      yield { type: 'text', catId, content: 'hi', timestamp: Date.now() };
      yield { type: 'done', catId, timestamp: Date.now() };
    },
  };
}

function createMockDeps(services) {
  let invocationSeq = 0;
  let messageSeq = 0;
  const storedById = new Map();
  return {
    services,
    toolEventLog: { append: async () => {}, updateSummary: async () => {} },
    invocationDeps: {
      registry: {
        create: () => ({ invocationId: `inner-inv-${++invocationSeq}`, callbackToken: `tok-${invocationSeq}` }),
        verify: () => ({ ok: false, reason: 'unknown_invocation' }),
      },
      sessionManager: {
        get: async () => null,
        getOrCreate: async () => ({}),
        resolveWorkingDirectory: () => '/tmp/test',
      },
      threadStore: {
        get: async () => null,
        getParticipantsWithActivity: async () => [],
        updateParticipantActivity: async () => {},
      },
      apiUrl: 'http://127.0.0.1:3004',
    },
    messageStore: {
      append: async (msg) => {
        const stored = { id: `msg-${++messageSeq}`, ...msg, threadId: msg.threadId ?? 'default' };
        storedById.set(stored.id, stored);
        return stored;
      },
      getById: async (id) => storedById.get(id) ?? null,
      getRecent: () => [],
      getMentionsFor: () => [],
      getRecentMentionsFor: () => [],
      getBefore: () => [],
      getByThread: () => [],
      getByThreadAfter: () => [],
      getByThreadBefore: () => [],
    },
    draftStore: { delete: () => Promise.resolve(), touch: () => Promise.resolve(), upsert: () => Promise.resolve() },
    socketManager: { broadcastToRoom: () => {} },
  };
}

describe('route-parallel per-cat cancel isolation (concurrent @ multi-cat)', () => {
  it('canceling the FIRST cat does NOT abort the sibling cat execution signal', async () => {
    // 复现铲屎官现象：取消 opus（第一只/primary）不应误伤 codex
    const captured = {};
    const services = {
      opus: makeCapturingService('opus', captured),
      codex: makeCapturingService('codex', captured),
    };
    const deps = createMockDeps(services);

    const opusCtrl = new AbortController();
    const codexCtrl = new AbortController();
    const signalForCat = (catId) => (catId === 'opus' ? opusCtrl.signal : codexCtrl.signal);

    for await (const _m of routeParallel(deps, ['opus', 'codex'], 'msg', 'user1', 't1', { signalForCat })) {
      // drain
    }

    assert.ok(captured.opus, 'opus must capture an execution signal');
    assert.ok(captured.codex, 'codex must capture an execution signal');

    // 用户只取消 opus（第一只）
    opusCtrl.abort('user_cancel');

    assert.equal(captured.opus.aborted, true, 'opus execution signal aborted by opus cancel');
    assert.equal(
      captured.codex.aborted,
      false,
      'codex execution signal MUST survive opus cancel — per-cat isolation, not shared primaryController',
    );
  });

  it('canceling a NON-first cat actually aborts that cat (and spares the first)', async () => {
    // 对称面：取消 codex（非 primary）必须真生效，不能因 abort 了没人监听的 controller 而无效
    const captured = {};
    const services = {
      opus: makeCapturingService('opus', captured),
      codex: makeCapturingService('codex', captured),
    };
    const deps = createMockDeps(services);

    const opusCtrl = new AbortController();
    const codexCtrl = new AbortController();
    const signalForCat = (catId) => (catId === 'opus' ? opusCtrl.signal : codexCtrl.signal);

    for await (const _m of routeParallel(deps, ['opus', 'codex'], 'msg', 'user1', 't1', { signalForCat })) {
      // drain
    }

    // 用户取消第二只（codex，非 primary）
    codexCtrl.abort('user_cancel');

    assert.equal(captured.codex.aborted, true, 'codex (non-first) execution signal MUST actually abort');
    assert.equal(captured.opus.aborted, false, 'opus execution signal survives codex cancel');
  });

  it('falls back to shared options.signal when signalForCat is absent (backward compat)', async () => {
    // 向后兼容：没传 signalForCat 时，沿用单一 options.signal（route-serial / 旧调用方）
    const captured = {};
    const services = {
      opus: makeCapturingService('opus', captured),
      codex: makeCapturingService('codex', captured),
    };
    const deps = createMockDeps(services);

    const sharedCtrl = new AbortController();

    for await (const _m of routeParallel(deps, ['opus', 'codex'], 'msg', 'user1', 't1', {
      signal: sharedCtrl.signal,
    })) {
      // drain
    }

    assert.ok(captured.opus && captured.codex, 'both cats captured a signal');
    sharedCtrl.abort('cancel_all');
    // 无 signalForCat 时共享语义保留：force-reset / cancel_all 仍能一次清掉所有猫
    assert.equal(captured.opus.aborted, true, 'shared signal still aborts opus');
    assert.equal(captured.codex.aborted, true, 'shared signal still aborts codex');
  });
});

describe('route-serial per-cat cancel isolation (concurrent @ multi-cat execute path)', () => {
  it('canceling the FIRST cat skips only that cat — worklist NOT broken, sibling still runs', async () => {
    // 铲屎官真实场景：@codex @gpt52（execute intent，无 #ideate）→ route-serial 串行 worklist。
    // 取消第一只（worklist[0] = primary）→ 旧代码 abort 共享 primaryController.signal →
    // loop 顶 `if (signal?.aborted) break` → 整个 worklist 停 → 第二只永不执行（= 两只一起没了）。
    const order = [];
    const captured = {};
    const makeService = (catId) => ({
      async *invoke(_prompt, options) {
        captured[catId] = options?.signal;
        order.push(catId);
        yield { type: 'text', catId, content: 'hi', timestamp: Date.now() };
        yield { type: 'done', catId, timestamp: Date.now() };
      },
    });
    const deps = createMockDeps({ opus: makeService('opus'), codex: makeService('codex') });

    // opus = worklist[0] = primary。其 controller 即生产里 startAll 返回的 primaryController。
    const opusCtrl = new AbortController();
    const codexCtrl = new AbortController();
    const signalForCat = (catId) => (catId === 'opus' ? opusCtrl.signal : codexCtrl.signal);
    opusCtrl.abort('user_cancel'); // 用户取消第一只（在 worklist 跑到它之前已取消）

    for await (const _m of routeSerial(deps, ['opus', 'codex'], 'msg', 'user1', 't1', {
      // 生产：QueueProcessor 传 signal = primaryController.signal（= opus 的，已 aborted）
      signal: opusCtrl.signal,
      signalForCat,
    })) {
      // drain
    }

    assert.ok(
      order.includes('codex'),
      'codex MUST still execute after opus(first) cancel — serial worklist must not break on a per-cat cancel',
    );
  });
});

// 砚砚 invariant red tests: REAL getController()+cancel() combo (not hand-rolled controllers) —
// exercise the tombstone + aggregate finalStatus lifecycle end to end.
describe('F-parallel-cancel invariants (real InvocationTracker + cancel)', () => {
  // Invariant 1: a cat cancelled BEFORE the route layer grabs its own signal must still see an
  // aborted signal (tombstone), be skipped, and NOT fall back to the (non-aborted) batch gate.
  it('inv1: serial — cancel a cat before its turn → tombstone aborted signal, cat skipped, sibling runs', async () => {
    const order = [];
    const makeService = (catId) => ({
      async *invoke(_prompt, _options) {
        order.push(catId);
        yield { type: 'text', catId, content: 'hi', timestamp: Date.now() };
        yield { type: 'done', catId, timestamp: Date.now() };
      },
    });
    const deps = createMockDeps({ opus: makeService('opus'), codex: makeService('codex') });

    const tracker = new InvocationTracker();
    const batchController = tracker.startAll('t1', ['opus', 'codex'], 'user1');
    const signalForCat = (catId) => tracker.getController('t1', catId)?.signal;
    // Cancel opus (worklist[0]) BEFORE the serial loop runs — tombstone, NOT deleted.
    tracker.cancel('t1', 'opus');

    for await (const _m of routeSerial(deps, ['opus', 'codex'], 'msg', 'user1', 't1', {
      signal: batchController.signal, // batch gate NOT aborted by a single-cat cancel
      signalForCat,
    })) {
      // drain
    }

    // If getController fell back to the (non-aborted) batch gate, opus would run. The tombstone
    // makes signalForCat('opus') return the aborted controller → opus is skipped.
    assert.ok(!order.includes('opus'), 'opus skipped (tombstone aborted signal, NOT batch fallback)');
    assert.ok(order.includes('codex'), 'codex still runs');
  });

  // Invariant 2: resolveFinalStatus aggregate — batch abort vs per-cat cancel.
  it('inv2: all target cats singly cancelled → canceled_by_user (NOT succeeded)', () => {
    const tracker = new InvocationTracker();
    const batch = tracker.startAll('t1', ['opus'], 'user1');
    tracker.cancel('t1', 'opus'); // single-cat cancel — batch gate NOT aborted
    assert.equal(batch.signal.aborted, false, 'single cancel does not abort the batch gate');
    const status = tracker.resolveFinalStatus('t1', ['opus'], { aborted: batch.signal.aborted });
    assert.equal(status, 'canceled_by_user', 'all targets cancelled → canceled_by_user, not succeeded');
  });

  it('inv2b: one cancelled + one completed → succeeded', () => {
    const tracker = new InvocationTracker();
    const batch = tracker.startAll('t1', ['opus', 'codex'], 'user1');
    tracker.cancel('t1', 'opus'); // opus tombstone
    tracker.completeAll('t1', ['codex'], batch); // codex completed → absent
    const status = tracker.resolveFinalStatus('t1', ['opus', 'codex'], { aborted: false });
    assert.equal(status, 'succeeded', 'one cancelled + one completed → succeeded (a cat ran)');
  });

  it('inv2c: whole-invocation abort (cancelAll) → canceled_by_user', () => {
    const tracker = new InvocationTracker();
    tracker.startAll('t1', ['opus', 'codex'], 'user1');
    tracker.cancelAll('t1', 'user1', 'cancel_all');
    const status = tracker.resolveFinalStatus('t1', ['opus', 'codex'], { aborted: true, reason: 'cancel_all' });
    assert.equal(status, 'canceled_by_user', 'whole-invocation cancelAll → canceled_by_user');
  });

  // Cloud codex review P1 (PR #1965): claimed QueueProcessor's consume-loop guard
  // `if (controller.signal.aborted) break` fires when the PRIMARY cat is cancelled, because
  // controller.signal IS the primary cat's aborted signal — preserving the @codex @gpt52 regression.
  // After the batchController split, startAll returns an INDEPENDENT batch gate; cancel(primary)
  // does NOT abort it, so the consume-loop break never fires on a single-cat cancel. This pins
  // exactly QueueProcessor:808 `controller = startAll(...)` used at the consume-loop guard (993/1090).
  it('cloud-P1: startAll batch gate (consume-loop guard) is NOT aborted by primary-cat cancel', () => {
    const tracker = new InvocationTracker();
    const consumeLoopController = tracker.startAll('t1', ['opus', 'codex'], 'user1'); // opus = catIds[0] = "primary"
    tracker.cancel('t1', 'opus'); // cancel the FIRST/primary target — the cloud-P1 scenario
    // QueueProcessor `if (controller.signal.aborted) break` evaluates THIS returned controller:
    assert.equal(
      consumeLoopController.signal.aborted,
      false,
      'startAll batch gate NOT aborted by primary cancel → consume-loop break never fires → sibling keeps streaming',
    );
    // The primary cat's OWN per-cat controller IS aborted (per-cat isolation intact):
    assert.equal(tracker.getController('t1', 'opus')?.signal.aborted, true, 'opus per-cat controller aborted');
    assert.equal(tracker.has('t1', 'codex'), true, 'codex sibling still active (not broken by primary cancel)');
  });

  // Cloud codex re-review P1 (b7310a9ea, InvocationTracker:256): all cats cancelled WHILE running →
  // route consumers call completeSlot on the abort-induced terminal message BEFORE the aggregate
  // finalStatus check; if completeSlot deleted the canceled tombstone, getSlotState would be
  // 'absent' → resolveFinalStatus 'succeeded' even though the user cancelled every cat.
  it('cloud-P1-256: complete/completeSlot keep canceled tombstones → finalStatus stays canceled_by_user', () => {
    const tracker = new InvocationTracker();
    const batch = tracker.startAll('t1', ['opus', 'codex'], 'user1');
    tracker.cancel('t1', 'opus'); // both cancelled while running
    tracker.cancel('t1', 'codex');
    // route consumers retire the abort-induced terminal messages BEFORE the aggregate check:
    tracker.completeSlot('t1', 'opus', batch);
    tracker.completeSlot('t1', 'codex', batch);
    assert.equal(tracker.getSlotState('t1', 'opus'), 'canceled', 'opus tombstone survives completeSlot');
    assert.equal(tracker.getSlotState('t1', 'codex'), 'canceled', 'codex tombstone survives completeSlot');
    const status = tracker.resolveFinalStatus('t1', ['opus', 'codex'], { aborted: false });
    assert.equal(status, 'canceled_by_user', 'all cancelled (tombstones survive completeSlot) → canceled_by_user');
  });

  // Cloud codex re-review P2 (b7310a9ea, route-parallel:430): a cat cancelled BEFORE the parallel
  // route invokes it must be SKIPPED, not invoked with an aborted signal (which would surface a
  // user_cancel as error+done). route-serial already skips via its loop-top catSignal?.aborted.
  it('cloud-P2-430: route-parallel skips invoke for a pre-cancelled cat (no error from aborted iterator)', async () => {
    const invoked = [];
    const makeService = (catId) => ({
      async *invoke(_prompt, _options) {
        invoked.push(catId);
        yield { type: 'text', catId, content: 'hi', timestamp: Date.now() };
        yield { type: 'done', catId, timestamp: Date.now() };
      },
    });
    const deps = createMockDeps({ opus: makeService('opus'), codex: makeService('codex') });
    const tracker = new InvocationTracker();
    tracker.startAll('t1', ['opus', 'codex'], 'user1');
    const signalForCat = (catId) => tracker.getController('t1', catId)?.signal;
    tracker.cancel('t1', 'opus'); // opus pre-cancelled (tombstone aborted signal)

    const messages = [];
    for await (const m of routeParallel(deps, ['opus', 'codex'], 'msg', 'user1', 't1', { signalForCat })) {
      messages.push(m);
    }

    assert.ok(!invoked.includes('opus'), 'opus pre-cancelled → invoke skipped (no error+done from aborted iterator)');
    assert.ok(invoked.includes('codex'), 'codex still invoked');
    // 砚砚 non-blocking follow-up: opus's empty-generator skip means one fewer real done — verify the
    // route still emits a final done (isFinal) via its done-guarantee, so the frontend clears loading
    // state (the skip / completedCount / isFinal / synthetic-final-done chain stays intact).
    const finalDones = messages.filter((m) => m.type === 'done' && m.isFinal === true);
    assert.ok(
      finalDones.length > 0,
      'route still emits a final done despite the opus skip (done-guarantee 收尾 intact)',
    );
  });
});

describe('cloud-#4: route-parallel suppresses abort-induced error (cancel AFTER stream started)', () => {
  it('does NOT yield a per-cat error once that cat is cancelled mid-stream', async () => {
    // opus streams, then the user clicks Stop on opus mid-stream → its signal aborts → invokeSingleCat's
    // abortableNext rejects and converts the abort into error+done. The batch gate is intentionally NOT
    // aborted on single-cat cancel, so the consume-loop's controller.signal.aborted guard never fires.
    // route-parallel must DROP opus's abort-induced error (mirror serial's `if (catSignal?.aborted) break`)
    // so it isn't broadcast/persisted as a provider failure. codex (not cancelled) streams normally.
    const opusCtrl = new AbortController();
    const codexCtrl = new AbortController();
    const signalForCat = (catId) => (catId === 'opus' ? opusCtrl.signal : codexCtrl.signal);
    const services = {
      opus: {
        async *invoke(_prompt, _options) {
          yield { type: 'text', catId: 'opus', content: 'partial', timestamp: Date.now() };
          opusCtrl.abort('user_cancel'); // user clicks Stop on opus mid-stream
          // stream stalls; invokeSingleCat's abortableNext sees the aborted signal and rejects.
          await new Promise(() => {});
          yield { type: 'text', catId: 'opus', content: 'never', timestamp: Date.now() };
        },
      },
      codex: makeCapturingService('codex', {}),
    };
    const deps = createMockDeps(services);

    const messages = [];
    for await (const m of routeParallel(deps, ['opus', 'codex'], 'msg', 'user1', 't1', { signalForCat })) {
      messages.push(m);
    }

    const opusErrors = messages.filter((m) => m.type === 'error' && m.catId === 'opus');
    assert.equal(
      opusErrors.length,
      0,
      'opus abort-induced error must NOT be yielded (no provider-failure broadcast/persist)',
    );
    assert.ok(
      messages.some((m) => m.type === 'text' && m.catId === 'codex'),
      'codex (not cancelled) streamed normally',
    );
  });
});

describe('cloud-#5: A2A external slot cancel isolation (serial handoff)', () => {
  it('trackExternalSlot gives the A2A slot an INDEPENDENT controller — cancel(catB) ≠ abort batch gate', () => {
    const tracker = new InvocationTracker();
    // catA worklist running; startAll returns the independent batch gate.
    const batchGate = tracker.startAll('t1', ['catA'], 'u1');
    // catA hands off to catB (pending A2A); route-serial passes options.invocationController = batch gate.
    tracker.trackExternalSlot('t1', 'catB', batchGate, 'u1', ['catB']);
    const catBCtrl = tracker.getController('t1', 'catB');
    assert.ok(catBCtrl, 'catB A2A slot registered');
    assert.notStrictEqual(
      catBCtrl,
      batchGate,
      'A2A slot must own an independent controller, not the shared batch gate',
    );
    // user clicks Stop on the pending A2A target catB only.
    tracker.cancel('t1', 'catB', 'u1');
    assert.ok(catBCtrl.signal.aborted, 'cancel(catB) aborts catB own controller');
    assert.ok(
      !batchGate.signal.aborted,
      'cancel(catB) must NOT abort the batch gate — the rest of the serial worklist keeps running',
    );
  });

  it('cancelAll still cascades to the A2A slot AND the batch gate (whole-invocation stop)', () => {
    const tracker = new InvocationTracker();
    const batchGate = tracker.startAll('t1', ['catA'], 'u1');
    tracker.trackExternalSlot('t1', 'catB', batchGate, 'u1', ['catB']);
    const catBCtrl = tracker.getController('t1', 'catB');
    tracker.cancelAll('t1', 'u1');
    assert.ok(catBCtrl.signal.aborted, 'cancelAll aborts the A2A slot controller');
    assert.ok(batchGate.signal.aborted, 'cancelAll aborts the batch gate');
  });
});

describe('cloud-#6: force preempt scoped to target invocation (not whole thread)', () => {
  it('cancelInvocation cancels only the anchor invocation, leaving an unrelated side-dispatch alive', () => {
    const tracker = new InvocationTracker();
    // invocation 1: codex (busy, user is force-targeting it) — its own batch
    const codexBatch = tracker.startAll('t1', ['codex'], 'u1');
    // unrelated side-dispatch: opus whisper to an idle cat (independent invocation, separate batch)
    const opusBatch = tracker.startAll('t1', ['opus'], 'u1');
    const codexCtrl = tracker.getController('t1', 'codex');
    const opusCtrl = tracker.getController('t1', 'opus');
    // force @codex → preempt ONLY codex's invocation
    const cancelled = tracker.cancelInvocation('t1', ['codex'], 'u1', 'preempted');
    assert.deepEqual(cancelled, ['codex'], 'only codex cancelled');
    assert.ok(codexCtrl.signal.aborted, 'codex preempted');
    assert.ok(codexBatch.signal.aborted, 'codex batch gate aborted');
    assert.ok(!opusCtrl.signal.aborted, 'unrelated opus side-dispatch must NOT be aborted (cloud #6)');
    assert.ok(!opusBatch.signal.aborted, 'unrelated opus batch gate must NOT be aborted');
  });

  it('cancelInvocation cancels multi-cat siblings sharing the SAME batch as the anchor', () => {
    const tracker = new InvocationTracker();
    // a single invocation targeting codex + gpt52 (shared batch gate)
    const batch = tracker.startAll('t1', ['codex', 'gpt52'], 'u1');
    const codexCtrl = tracker.getController('t1', 'codex');
    const gpt52Ctrl = tracker.getController('t1', 'gpt52');
    // force @codex → preempt the WHOLE codex+gpt52 invocation (siblings share the batch)
    const cancelled = tracker.cancelInvocation('t1', ['codex'], 'u1', 'preempted');
    assert.ok(cancelled.includes('codex') && cancelled.includes('gpt52'), 'both batch siblings cancelled');
    assert.ok(codexCtrl.signal.aborted && gpt52Ctrl.signal.aborted, 'both siblings aborted');
    assert.ok(batch.signal.aborted, 'shared batch gate aborted');
  });
});
