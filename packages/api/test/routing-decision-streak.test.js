import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

/**
 * F216 c1.1: peekStreakOnPush — pure-read streak prediction.
 *
 * The decision layer (resolveRoutingDecisions) must predict whether pushing a cat would trip the
 * ping-pong breaker WITHOUT mutating worklistEntry.streakPair. updateStreakOnPush mutates (count++ /
 * reset) — that side effect belongs in the execution layer. peekStreakOnPush computes the same
 * verdict read-only so the decision function stays pure (砚砚 OQ3: no side effects in the decision).
 */

const REG_PATH = '../dist/domains/cats/services/agents/routing/WorklistRegistry.js';

function makeEntry() {
  return {
    list: ['opus'],
    originalCount: 1,
    a2aCount: 0,
    maxDepth: 10,
    executedIndex: 0,
    a2aFrom: new Map(),
    a2aTriggerMessageId: new Map(),
    // no streakPair yet
  };
}

describe('peekStreakOnPush (F216 c1.1) — pure read, no mutation', () => {
  test('does NOT mutate entry.streakPair', async () => {
    const { peekStreakOnPush } = await import(REG_PATH);
    const entry = makeEntry();
    entry.streakPair = { from: 'opus', to: 'codex', count: 3 };
    const before = { ...entry.streakPair };
    peekStreakOnPush(entry, 'opus', 'codex', { hadSubstantiveToolCall: false, outputLength: 10 });
    assert.deepEqual(entry.streakPair, before, 'peek must not change streakPair (no count++, no reset)');
  });

  test('predicts wouldBlock at the block threshold (same pair, inertia → would be count 4)', async () => {
    const { peekStreakOnPush } = await import(REG_PATH);
    const entry = makeEntry();
    entry.streakPair = { from: 'opus', to: 'codex', count: 3 }; // next inertia push → 4 = block
    const r = peekStreakOnPush(entry, 'opus', 'codex', { hadSubstantiveToolCall: false, outputLength: 10 });
    assert.equal(r.wouldBlock, true, 'count 3 + inertia push → 4 ≥ block threshold');
    assert.equal(r.count, 4, 'predicted post-push count');
  });

  test('predicts NO block when substantive activity resets the streak', async () => {
    const { peekStreakOnPush } = await import(REG_PATH);
    const entry = makeEntry();
    entry.streakPair = { from: 'opus', to: 'codex', count: 3 };
    // substantive (long output) → reset to 1, not 4
    const r = peekStreakOnPush(entry, 'opus', 'codex', { hadSubstantiveToolCall: true, outputLength: 10 });
    assert.equal(r.wouldBlock, false, 'substantive work breaks inertia → no block');
    assert.equal(r.count, 1, 'substantive resets predicted count to 1');
  });

  test('predicts count 1 for a fresh pair (no prior streak)', async () => {
    const { peekStreakOnPush } = await import(REG_PATH);
    const entry = makeEntry(); // no streakPair
    const r = peekStreakOnPush(entry, 'opus', 'gemini', { hadSubstantiveToolCall: false, outputLength: 10 });
    assert.equal(r.count, 1, 'new pair starts at 1');
    assert.equal(r.wouldBlock, false);
  });

  test('peek result matches what updateStreakOnPush would actually produce (parity)', async () => {
    const { peekStreakOnPush, updateStreakOnPush } = await import(REG_PATH);
    // two identical entries; peek one, mutate the other; verdicts must match
    const peeked = makeEntry();
    peeked.streakPair = { from: 'opus', to: 'codex', count: 2 };
    const mutated = makeEntry();
    mutated.streakPair = { from: 'opus', to: 'codex', count: 2 };
    const activity = { hadSubstantiveToolCall: false, outputLength: 10 };
    const peek = peekStreakOnPush(peeked, 'opus', 'codex', activity);
    const real = updateStreakOnPush(mutated, 'opus', 'codex', activity);
    assert.equal(peek.wouldBlock, real.blockPingPong, 'block verdict parity');
    assert.equal(peek.count, real.count, 'count parity');
  });
});
