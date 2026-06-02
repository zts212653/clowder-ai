import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

/**
 * F216 c1.2: resolveRoutingDecisions — PURE decision function.
 *
 * Unifies the depth/dedup/streak/pendingTail guards that today are duplicated across the inline-
 * mention and relay branches of routeSerial. Returns RoutingDecision[] (structured verdicts); the
 * execution layer applies side effects (worklist.push, updateStreakOnPush, span, yield). No mutation
 * here — streak is predicted read-only via ctx.peekStreak (砚砚 OQ3, plan 约束1).
 */

const PATH = '../dist/domains/cats/services/agents/routing/routing-decision.js';

/** Build a RoutingContext with sane defaults; override per-test. */
function ctx(over = {}) {
  return {
    a2aCount: 0,
    maxDepth: 10,
    aborted: false,
    queuedMessagesPending: false,
    pendingTail: [],
    pendingOriginalTargets: [],
    hasActiveAgent: () => false,
    // default: never blocks, predicted count 1
    peekStreak: () => ({ wouldBlock: false, count: 1 }),
    ...over,
  };
}

describe('resolveRoutingDecisions — inline_mention', () => {
  test('enqueues a fresh mentioned cat (happy path)', async () => {
    const { resolveRoutingDecisions } = await import(PATH);
    const out = resolveRoutingDecisions(
      { type: 'inline_mention', cats: ['codex'], content: 'hi', callerCatId: 'opus' },
      ctx(),
    );
    assert.deepEqual(out, [{ action: 'enqueue_worklist', cat: 'codex' }]);
  });

  test('skip:aborted when signal aborted', async () => {
    const { resolveRoutingDecisions } = await import(PATH);
    const out = resolveRoutingDecisions(
      { type: 'inline_mention', cats: ['codex'], content: 'hi', callerCatId: 'opus' },
      ctx({ aborted: true }),
    );
    assert.deepEqual(out, [{ action: 'skip', cat: 'codex', reason: 'aborted' }]);
  });

  test('skip:queue_pending when non-agent messages pending (fairness gate)', async () => {
    const { resolveRoutingDecisions } = await import(PATH);
    const out = resolveRoutingDecisions(
      { type: 'inline_mention', cats: ['codex'], content: 'hi', callerCatId: 'opus' },
      ctx({ queuedMessagesPending: true }),
    );
    assert.deepEqual(out, [{ action: 'defer_queue', cat: 'codex' }]);
  });

  test('skip:depth when a2aCount >= maxDepth', async () => {
    const { resolveRoutingDecisions } = await import(PATH);
    const out = resolveRoutingDecisions(
      { type: 'inline_mention', cats: ['codex'], content: 'hi', callerCatId: 'opus' },
      ctx({ a2aCount: 10, maxDepth: 10 }),
    );
    assert.deepEqual(out, [{ action: 'skip', cat: 'codex', reason: 'depth' }]);
  });

  test('skip:dedup_active when target already processing in InvocationQueue', async () => {
    const { resolveRoutingDecisions } = await import(PATH);
    const out = resolveRoutingDecisions(
      { type: 'inline_mention', cats: ['codex'], content: 'hi', callerCatId: 'opus' },
      ctx({ hasActiveAgent: (c) => c === 'codex' }),
    );
    assert.deepEqual(out, [{ action: 'skip', cat: 'codex', reason: 'dedup_active' }]);
  });

  test('mark_replyto when cat already in pendingTail but NOT an original target', async () => {
    const { resolveRoutingDecisions } = await import(PATH);
    const out = resolveRoutingDecisions(
      { type: 'inline_mention', cats: ['codex'], content: 'hi', callerCatId: 'opus' },
      ctx({ pendingTail: ['codex'], pendingOriginalTargets: [] }),
    );
    assert.deepEqual(out, [{ action: 'mark_replyto', cat: 'codex' }]);
  });

  test('SKIPS entirely (empty decision) when cat is a pending ORIGINAL target (replies to user)', async () => {
    const { resolveRoutingDecisions } = await import(PATH);
    const out = resolveRoutingDecisions(
      { type: 'inline_mention', cats: ['codex'], content: 'hi', callerCatId: 'opus' },
      ctx({ pendingTail: ['codex'], pendingOriginalTargets: ['codex'] }),
    );
    // original target stays replying to user — no decision emitted for it
    assert.deepEqual(out, []);
  });

  test('block_pingpong when peekStreak says wouldBlock', async () => {
    const { resolveRoutingDecisions } = await import(PATH);
    const out = resolveRoutingDecisions(
      { type: 'inline_mention', cats: ['codex'], content: 'hi', callerCatId: 'opus' },
      ctx({ peekStreak: () => ({ wouldBlock: true, count: 4 }) }),
    );
    assert.deepEqual(out, [{ action: 'block_pingpong', cat: 'codex', pairCount: 4 }]);
  });

  test('multi-cat: per-target decisions in order', async () => {
    const { resolveRoutingDecisions } = await import(PATH);
    const out = resolveRoutingDecisions(
      { type: 'inline_mention', cats: ['codex', 'gemini'], content: 'hi', callerCatId: 'opus' },
      ctx({ hasActiveAgent: (c) => c === 'codex' }),
    );
    assert.deepEqual(out, [
      { action: 'skip', cat: 'codex', reason: 'dedup_active' },
      { action: 'enqueue_worklist', cat: 'gemini' },
    ]);
  });

  test('depth budget consumed across multi-cat: 2nd cat hits depth after 1st enqueues', async () => {
    const { resolveRoutingDecisions } = await import(PATH);
    // a2aCount starts at maxDepth-1: first enqueue consumes the last slot, second hits depth
    const out = resolveRoutingDecisions(
      { type: 'inline_mention', cats: ['codex', 'gemini'], content: 'hi', callerCatId: 'opus' },
      ctx({ a2aCount: 9, maxDepth: 10 }),
    );
    assert.deepEqual(out, [
      { action: 'enqueue_worklist', cat: 'codex' },
      { action: 'skip', cat: 'gemini', reason: 'depth' },
    ]);
  });

  // 砚砚 review PR#1991 P2: a defer_queue is ALSO an A2A route slot (it enqueues a handoff, just
  // behind non-agent messages), so it must consume the depth budget too — otherwise a batch resolve
  // could emit unlimited defer_queue past maxDepth. The execution layer happens to call one cat at a
  // time, but the PURE function's contract must be self-consistent for any input.
  test('depth budget consumed by defer_queue too: 2nd deferred cat hits depth after 1st defers', async () => {
    const { resolveRoutingDecisions } = await import(PATH);
    // queuedMessagesPending=true → every cat resolves to defer_queue. a2aCount=maxDepth-1 means the
    // first defer consumes the last slot; the second must hit depth, NOT emit a 2nd defer_queue.
    const out = resolveRoutingDecisions(
      { type: 'deferred', cats: ['codex', 'gemini'], content: 'hi', callerCatId: 'opus' },
      ctx({ a2aCount: 9, maxDepth: 10, queuedMessagesPending: true }),
    );
    assert.deepEqual(out, [
      { action: 'defer_queue', cat: 'codex' },
      { action: 'skip', cat: 'gemini', reason: 'depth' },
    ]);
  });
});

describe('resolveRoutingDecisions — relay_malformed', () => {
  test('enqueues relay cat when not already pending', async () => {
    const { resolveRoutingDecisions } = await import(PATH);
    const out = resolveRoutingDecisions(
      { type: 'relay_malformed', cat: 'opus', callerCatId: 'opus-48' },
      ctx({ pendingTail: [] }),
    );
    assert.deepEqual(out, [{ action: 'enqueue_worklist', cat: 'opus' }]);
  });

  test('skip when relay cat already pending (F215 pending-only dedup,逐字保留)', async () => {
    const { resolveRoutingDecisions } = await import(PATH);
    const out = resolveRoutingDecisions(
      { type: 'relay_malformed', cat: 'opus', callerCatId: 'opus-48' },
      ctx({ pendingTail: ['opus'] }),
    );
    assert.deepEqual(out, [{ action: 'skip', cat: 'opus', reason: 'dedup_active' }]);
  });

  test('relay does NOT consult streak/queue fairness (only depth + pending dedup)', async () => {
    const { resolveRoutingDecisions } = await import(PATH);
    // even with queuedMessagesPending + would-block streak, relay still enqueues (it is a recovery
    // path, not subject to ping-pong / fairness gates that apply to text-scan mentions)
    const out = resolveRoutingDecisions(
      { type: 'relay_malformed', cat: 'opus', callerCatId: 'opus-48' },
      ctx({ queuedMessagesPending: true, peekStreak: () => ({ wouldBlock: true, count: 9 }) }),
    );
    assert.deepEqual(out, [{ action: 'enqueue_worklist', cat: 'opus' }]);
  });

  test('relay skip:depth when at depth limit', async () => {
    const { resolveRoutingDecisions } = await import(PATH);
    const out = resolveRoutingDecisions(
      { type: 'relay_malformed', cat: 'opus', callerCatId: 'opus-48' },
      ctx({ a2aCount: 10, maxDepth: 10 }),
    );
    assert.deepEqual(out, [{ action: 'skip', cat: 'opus', reason: 'depth' }]);
  });
});
