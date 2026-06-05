import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

// F224 SessionContinuationCoordinator — continuation lifecycle owner.
// 四象限坐标系：Coordinator(continuation lifecycle) / Queue(A2A fan-in) /
// Route(route state) / Invoke(session runtime)。
// 设计图：docs/plans/2026-06-04-session-continuation-coordinator-design.md
// 接口全 async（砚砚 P1：真实 threadStore 是 Redis async）。
const { SessionContinuationCoordinator } = await import(
  '../dist/domains/cats/services/agents/invocation/SessionContinuationCoordinator.js'
);

/** Minimal fake threadStore — 故意不提供 tracker/cancel/slot API（F220 边界硬隔离，砚砚 P1/Q5）。 */
function fakeDeps(overrides = {}) {
  return {
    threadStore: {
      getMemberSessionStrategy: () => undefined,
      ...overrides.threadStore,
    },
    ...overrides,
  };
}

/** 合法 CollaborationContinuityCapsuleV1（seal 过的）。 */
function makeCapsule(overrides = {}) {
  return {
    v: 1,
    threadId: 't1',
    catId: 'opus',
    mode: 'serial',
    a2aEnabled: true,
    ballState: 'in_progress',
    continuationReason: 'threshold_seal',
    createdAt: 1,
    seal: { sessionId: 's1', sessionSeq: 1, reason: 'threshold_seal' },
    ...overrides,
  };
}

describe('SessionContinuationCoordinator', () => {
  describe('resolveSessionStrategy (#836 集中 policy read，不散 4 处 isRebornSession)', () => {
    it('returns reborn when member strategy is reborn', async () => {
      const coord = new SessionContinuationCoordinator(
        fakeDeps({ threadStore: { getMemberSessionStrategy: () => 'reborn' } }),
      );
      assert.equal(await coord.resolveSessionStrategy('t1', 'opus', 'u1'), 'reborn');
    });

    it('defaults to resume when member strategy unset', async () => {
      const coord = new SessionContinuationCoordinator(
        fakeDeps({ threadStore: { getMemberSessionStrategy: () => undefined } }),
      );
      assert.equal(await coord.resolveSessionStrategy('t1', 'opus', 'u1'), 'resume');
    });

    it('returns resume when member strategy explicitly resume', async () => {
      const coord = new SessionContinuationCoordinator(
        fakeDeps({ threadStore: { getMemberSessionStrategy: () => 'resume' } }),
      );
      assert.equal(await coord.resolveSessionStrategy('t1', 'opus', 'u1'), 'resume');
    });

    it('awaits async store — Redis-backed Promise deps (砚砚 P1)', async () => {
      const coord = new SessionContinuationCoordinator(
        fakeDeps({ threadStore: { getMemberSessionStrategy: () => Promise.resolve('reborn') } }),
      );
      assert.equal(await coord.resolveSessionStrategy('t1', 'opus', 'u1'), 'reborn');
    });
  });

  describe('prepareInvocationContext (#813 passive seal consume + #836 reborn skip)', () => {
    it('reborn: skips consume, returns original content, no token (#836)', async () => {
      let consumeCalled = false;
      const coord = new SessionContinuationCoordinator({
        threadStore: {
          getMemberSessionStrategy: () => 'reborn',
          consumePendingContinuation: () => {
            consumeCalled = true;
            return null;
          },
        },
      });
      const r = await coord.prepareInvocationContext({ threadId: 't1', catId: 'opus', userId: 'u1', content: 'hello' });
      assert.equal(r.content, 'hello');
      assert.equal(r.sessionPolicy, 'reborn');
      assert.equal(r.consumedContinuation, undefined);
      assert.equal(consumeCalled, false, 'reborn MUST NOT consume pending continuation');
    });

    it('resume + pending capsule: consumes (async), injects continuation prompt, returns token', async () => {
      const capsule = makeCapsule();
      const coord = new SessionContinuationCoordinator({
        threadStore: {
          getMemberSessionStrategy: () => 'resume',
          consumePendingContinuation: () => Promise.resolve(capsule), // async store
        },
      });
      const r = await coord.prepareInvocationContext({ threadId: 't1', catId: 'opus', userId: 'u1', content: 'hello' });
      assert.match(r.content, /System Continuation/, 'must inject continuation prompt');
      assert.ok(r.consumedContinuation, 'must return token so commit can restore-on-failure');
      assert.equal(r.sessionPolicy, 'resume');
    });

    it('resume + no pending: returns original content, no token', async () => {
      const coord = new SessionContinuationCoordinator({
        threadStore: {
          getMemberSessionStrategy: () => 'resume',
          consumePendingContinuation: () => null,
        },
      });
      const r = await coord.prepareInvocationContext({ threadId: 't1', catId: 'opus', userId: 'u1', content: 'hello' });
      assert.equal(r.content, 'hello');
      assert.equal(r.consumedContinuation, undefined);
    });
  });

  describe('commitInvocationOutcome (砚砚 P1: failure restore / 多 capsule / new 优先 / canceled_by_user / identity)', () => {
    /** 捕获 setPendingContinuation 调用。strategyByCat：per-cat 策略（#836 是 per-cat，砚砚 re-review）。 */
    function captureStore(strategyByCat = {}) {
      const calls = [];
      return {
        calls,
        threadStore: {
          getMemberSessionStrategy: (_threadId, catId) => strategyByCat[catId],
          setPendingContinuation: (threadId, catId, userId, capsule) =>
            calls.push({ threadId, catId, userId, capsule }),
        },
      };
    }

    it('succeeded + produced capsule → stores pending for next invocation', async () => {
      const { calls, threadStore } = captureStore();
      const coord = new SessionContinuationCoordinator({ threadStore });
      const capsule = makeCapsule();
      await coord.commitInvocationOutcome({
        finalStatus: 'succeeded',
        threadId: 't1',
        catId: 'opus',
        userId: 'u1',
        producedCapsules: [capsule],
      });
      assert.equal(calls.length, 1);
      assert.equal(calls[0].capsule, capsule);
    });

    it('failed + consumed token (no produced) → restores consumed capsule (砚砚 P1)', async () => {
      const { calls, threadStore } = captureStore();
      const coord = new SessionContinuationCoordinator({ threadStore });
      const consumed = { capsule: makeCapsule(), threadId: 't1', catId: 'opus', userId: 'u1' };
      await coord.commitInvocationOutcome({
        finalStatus: 'failed',
        threadId: 't1',
        catId: 'opus',
        userId: 'u1',
        consumedContinuation: consumed,
      });
      assert.equal(calls.length, 1);
      assert.equal(calls[0].capsule, consumed.capsule, 'must restore the consumed capsule');
    });

    it('failed + consumed + NEW produced → new capsule wins over restore (砚砚 P1)', async () => {
      const { calls, threadStore } = captureStore();
      const coord = new SessionContinuationCoordinator({ threadStore });
      const consumed = {
        capsule: makeCapsule({ seal: { sessionId: 'OLD', sessionSeq: 1, reason: 'x' } }),
        threadId: 't1',
        catId: 'opus',
        userId: 'u1',
      };
      const fresh = makeCapsule({ seal: { sessionId: 'NEW', sessionSeq: 2, reason: 'y' } });
      await coord.commitInvocationOutcome({
        finalStatus: 'failed',
        threadId: 't1',
        catId: 'opus',
        userId: 'u1',
        consumedContinuation: consumed,
        producedCapsules: [fresh],
      });
      assert.equal(calls.length, 1);
      assert.equal(calls[0].capsule.seal.sessionId, 'NEW', 'new capsule wins; do NOT restore stale old');
    });

    it('canceled_by_user + consumed → restores (canceled_by_user is a real finalStatus, 砚砚 P1)', async () => {
      const { calls, threadStore } = captureStore();
      const coord = new SessionContinuationCoordinator({ threadStore });
      const consumed = { capsule: makeCapsule(), threadId: 't1', catId: 'opus', userId: 'u1' };
      await coord.commitInvocationOutcome({
        finalStatus: 'canceled_by_user',
        threadId: 't1',
        catId: 'opus',
        userId: 'u1',
        consumedContinuation: consumed,
      });
      assert.equal(calls.length, 1);
      assert.equal(calls[0].capsule, consumed.capsule);
    });

    it('reborn capsule → that capsule skipped (#836, per-cat)', async () => {
      const { calls, threadStore } = captureStore({ opus: 'reborn' });
      const coord = new SessionContinuationCoordinator({ threadStore });
      await coord.commitInvocationOutcome({
        finalStatus: 'succeeded',
        threadId: 't1',
        catId: 'opus',
        userId: 'u1',
        producedCapsules: [makeCapsule()],
      });
      assert.equal(calls.length, 0, 'reborn cat capsule must not be stored');
    });

    // ── 砚砚 re-review P1: reborn 策略必须 per-cat（按数据自身 identity），不按 commit input 判 ──

    it('mixed produced: opus(resume) + codex(reborn) → only opus stored (砚砚 re-review P1)', async () => {
      const { calls, threadStore } = captureStore({ codex: 'reborn' }); // opus resume (unset), codex reborn
      const coord = new SessionContinuationCoordinator({ threadStore });
      await coord.commitInvocationOutcome({
        finalStatus: 'succeeded',
        threadId: 't1',
        catId: 'opus',
        userId: 'u1',
        producedCapsules: [makeCapsule({ catId: 'opus' }), makeCapsule({ catId: 'codex' })],
      });
      assert.equal(calls.length, 1);
      assert.equal(calls[0].catId, 'opus', 'only opus(resume) stored; codex(reborn) capsule skipped per-cat');
    });

    it('input cat reborn but a produced cat is resume → resume capsule still stored (砚砚 re-review P1)', async () => {
      const { calls, threadStore } = captureStore({ opus: 'reborn' }); // input cat opus reborn; codex resume
      const coord = new SessionContinuationCoordinator({ threadStore });
      await coord.commitInvocationOutcome({
        finalStatus: 'succeeded',
        threadId: 't1',
        catId: 'opus',
        userId: 'u1',
        producedCapsules: [makeCapsule({ catId: 'codex' })],
      });
      assert.equal(calls.length, 1);
      assert.equal(calls[0].catId, 'codex', 'codex(resume) stored even though commit input cat opus is reborn');
    });

    it('restore skipped when TOKEN cat is reborn, even if input cat is resume (砚砚 re-review P1)', async () => {
      const { calls, threadStore } = captureStore({ codex: 'reborn' }); // token cat codex reborn; input opus resume
      const coord = new SessionContinuationCoordinator({ threadStore });
      const consumed = { capsule: makeCapsule({ catId: 'codex' }), threadId: 't1', catId: 'codex', userId: 'u1' };
      await coord.commitInvocationOutcome({
        finalStatus: 'failed',
        threadId: 't1',
        catId: 'opus',
        userId: 'u1',
        consumedContinuation: consumed,
      });
      assert.equal(calls.length, 0, 'codex(reborn) token must NOT be restored, despite input cat opus being resume');
    });

    it('produced multiple capsules → each stored under its OWN catId (砚砚 P1#2)', async () => {
      const { calls, threadStore } = captureStore();
      const coord = new SessionContinuationCoordinator({ threadStore });
      const opusCap = makeCapsule({ catId: 'opus' });
      const codexCap = makeCapsule({ catId: 'codex' });
      await coord.commitInvocationOutcome({
        finalStatus: 'succeeded',
        threadId: 't1',
        catId: 'opus',
        userId: 'u1',
        producedCapsules: [opusCap, codexCap],
      });
      assert.equal(calls.length, 2);
      assert.deepEqual(
        calls.map((c) => c.catId).sort(),
        ['codex', 'opus'],
        'each capsule stored under its own catId, not commit input catId',
      );
    });

    // ── 云端 P1: produced 全 reborn skip 时必须 fall through 到 restore（不能 early return） ──

    it('failed + consumed + produced ALL reborn-skipped → must restore consumed (云端 P1)', async () => {
      // Scenario: opus(resume) consumed a continuation; produced=[codex(reborn)] — codex skipped.
      // produced.length > 0 but nothing stored → consumed must still be restored.
      const { calls, threadStore } = captureStore({ codex: 'reborn' }); // codex reborn, opus resume
      const coord = new SessionContinuationCoordinator({ threadStore });
      const consumed = { capsule: makeCapsule({ catId: 'opus' }), threadId: 't1', catId: 'opus', userId: 'u1' };
      await coord.commitInvocationOutcome({
        finalStatus: 'failed',
        threadId: 't1',
        catId: 'opus',
        userId: 'u1',
        consumedContinuation: consumed,
        producedCapsules: [makeCapsule({ catId: 'codex' })], // all reborn → all skipped
      });
      assert.equal(calls.length, 1, 'consumed must be restored when all produced capsules were skipped');
      assert.equal(calls[0].catId, 'opus', 'restore under consumed token identity');
      assert.equal(calls[0].capsule, consumed.capsule);
    });

    it('failed + consumed(A) + produced stored for different cat(B) → must restore consumed(A) (云端 P1#2)', async () => {
      // Scenario: consumed opus continuation; produced codex capsule (resume, stored).
      // storedCount>0 but no capsule supersedes consumed opus identity → opus must be restored.
      const { calls, threadStore } = captureStore(); // both resume
      const coord = new SessionContinuationCoordinator({ threadStore });
      const consumed = { capsule: makeCapsule({ catId: 'opus' }), threadId: 't1', catId: 'opus', userId: 'u1' };
      await coord.commitInvocationOutcome({
        finalStatus: 'failed',
        threadId: 't1',
        catId: 'opus',
        userId: 'u1',
        consumedContinuation: consumed,
        producedCapsules: [makeCapsule({ catId: 'codex' })], // stored for codex, not opus
      });
      // codex capsule stored + opus consumed restored = 2 calls
      assert.equal(calls.length, 2, 'codex stored + opus consumed restored');
      const codexCall = calls.find((c) => c.catId === 'codex');
      const opusCall = calls.find((c) => c.catId === 'opus');
      assert.ok(codexCall, 'codex capsule stored');
      assert.ok(opusCall, 'opus consumed capsule restored');
      assert.equal(opusCall.capsule, consumed.capsule, 'restore the original consumed capsule');
    });

    it('cross-thread produced capsule rejected — threadId mismatch guard (云端 P1#3)', async () => {
      // Capsule with threadId !== invocation threadId must be silently rejected (parity with QueueProcessor).
      const { calls, threadStore } = captureStore();
      const coord = new SessionContinuationCoordinator({ threadStore });
      await coord.commitInvocationOutcome({
        finalStatus: 'succeeded',
        threadId: 't1',
        catId: 'opus',
        userId: 'u1',
        producedCapsules: [makeCapsule({ threadId: 'OTHER_THREAD', catId: 'opus' })],
      });
      assert.equal(calls.length, 0, 'capsule with mismatched threadId must be rejected');
    });

    it('restore uses consumed token identity, not commit input identity (砚砚 P2)', async () => {
      const { calls, threadStore } = captureStore();
      const coord = new SessionContinuationCoordinator({ threadStore });
      // token consumed for codex; commit input cat is opus — restore must follow the token
      const consumed = { capsule: makeCapsule({ catId: 'codex' }), threadId: 't1', catId: 'codex', userId: 'u1' };
      await coord.commitInvocationOutcome({
        finalStatus: 'failed',
        threadId: 't1',
        catId: 'opus',
        userId: 'u1',
        consumedContinuation: consumed,
      });
      assert.equal(calls.length, 1);
      assert.equal(calls[0].catId, 'codex', 'restore under token identity (codex), not commit input (opus)');
    });
  });
});
