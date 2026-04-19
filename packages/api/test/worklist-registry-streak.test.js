/**
 * F167 L1: Ping-pong streak tracking on WorklistRegistry.
 *
 * streak = 连续 same-pair（不区分方向）在 pushToWorklist 上的 push 次数。
 * streak >= 2 → warnPingPong
 * streak >= 4 → blockPingPong（不加入 list）
 * 不同 pair 的 push / 第三只猫插入 / resetStreak → 重置为 {new pair, count=1} 或空
 */

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

async function loadRegistry() {
  return await import('../dist/domains/cats/services/agents/routing/WorklistRegistry.js');
}

describe('F167 L1: WorklistRegistry ping-pong streak', () => {
  test('single push with caller = streak starts at 1, no warn', async () => {
    const { registerWorklist, unregisterWorklist, pushToWorklist } = await loadRegistry();
    const threadId = 'test-streak-1push';
    const entry = registerWorklist(threadId, ['opus'], 10);
    try {
      const result = pushToWorklist(threadId, ['codex'], 'opus');
      assert.deepEqual(result.added, ['codex']);
      assert.ok(!result.warnPingPong, 'first push must not warn');
      assert.ok(!result.blockPingPong, 'first push must not block');
      assert.ok(entry.streakPair, 'streakPair must be populated after first push');
      assert.equal(entry.streakPair.count, 1);
    } finally {
      unregisterWorklist(threadId, entry);
    }
  });

  test('A→B then B→A (same pair reversed): streak=2 → warnPingPong', async () => {
    const { registerWorklist, unregisterWorklist, pushToWorklist } = await loadRegistry();
    const threadId = 'test-streak-warn';
    const entry = registerWorklist(threadId, ['opus'], 10);
    try {
      pushToWorklist(threadId, ['codex'], 'opus'); // push 1: opus→codex, streak=1
      entry.executedIndex = 1; // now codex is current
      const result = pushToWorklist(threadId, ['opus'], 'codex'); // push 2: codex→opus, streak=2
      assert.deepEqual(result.added, ['opus']);
      assert.ok(result.warnPingPong, 'streak=2 must trigger warnPingPong');
      assert.ok(!result.blockPingPong, 'streak=2 must NOT block yet');
      assert.equal(entry.streakPair.count, 2);
    } finally {
      unregisterWorklist(threadId, entry);
    }
  });

  test('A↔B × 4 rounds: streak=4 → blockPingPong + added=[]', async () => {
    const { registerWorklist, unregisterWorklist, pushToWorklist } = await loadRegistry();
    const threadId = 'test-streak-block';
    const entry = registerWorklist(threadId, ['opus'], 20);
    try {
      // Round 1: opus→codex
      pushToWorklist(threadId, ['codex'], 'opus');
      entry.executedIndex = 1;
      // Round 2: codex→opus (warn)
      pushToWorklist(threadId, ['opus'], 'codex');
      entry.executedIndex = 2;
      // Round 3: opus→codex (still warn)
      pushToWorklist(threadId, ['codex'], 'opus');
      entry.executedIndex = 3;
      // Round 4: codex→opus → BLOCK
      const result = pushToWorklist(threadId, ['opus'], 'codex');
      assert.deepEqual(result.added, [], 'streak=4 must not enqueue');
      assert.ok(result.blockPingPong, 'streak=4 must set blockPingPong');
      assert.equal(result.reason, 'pingpong_terminated');
    } finally {
      unregisterWorklist(threadId, entry);
    }
  });

  test('different pair resets streak (A→B then A→C)', async () => {
    const { registerWorklist, unregisterWorklist, pushToWorklist } = await loadRegistry();
    const threadId = 'test-streak-diff-pair';
    const entry = registerWorklist(threadId, ['opus'], 10);
    try {
      pushToWorklist(threadId, ['codex'], 'opus'); // {opus,codex}=1
      const result = pushToWorklist(threadId, ['gemini'], 'opus'); // {opus,gemini}=1 (reset)
      assert.deepEqual(result.added, ['gemini']);
      assert.ok(!result.warnPingPong, 'new pair must reset to 1 (no warn)');
      assert.equal(entry.streakPair.count, 1);
      assert.ok(
        (entry.streakPair.from === 'opus' && entry.streakPair.to === 'gemini') ||
          (entry.streakPair.from === 'gemini' && entry.streakPair.to === 'opus'),
        'streakPair must be the latest pair {opus,gemini}',
      );
    } finally {
      unregisterWorklist(threadId, entry);
    }
  });

  test('third-cat injection resets streak (A↔B once, then C→A)', async () => {
    const { registerWorklist, unregisterWorklist, pushToWorklist } = await loadRegistry();
    const threadId = 'test-streak-third-cat';
    const entry = registerWorklist(threadId, ['opus'], 10);
    try {
      pushToWorklist(threadId, ['codex'], 'opus'); // {opus,codex}=1
      entry.executedIndex = 1;
      pushToWorklist(threadId, ['opus'], 'codex'); // {opus,codex}=2, warn
      // Now simulate a third cat (gemini) becoming the current cat via executedIndex advance
      entry.list.push('gemini');
      entry.executedIndex = 3; // gemini now current — but we're skipping to show insertion
      // Actually: third cat enters via being caller — gemini→opus is a different pair
      const result = pushToWorklist(threadId, ['opus'], 'gemini');
      assert.ok(!result.warnPingPong, 'third-cat caller must reset streak');
      assert.equal(entry.streakPair.count, 1);
    } finally {
      unregisterWorklist(threadId, entry);
    }
  });

  test('resetStreak API zeros out streakPair (for user-message hook)', async () => {
    const { registerWorklist, unregisterWorklist, pushToWorklist, resetStreak } = await loadRegistry();
    const threadId = 'test-streak-reset-api';
    const entry = registerWorklist(threadId, ['opus'], 10);
    try {
      pushToWorklist(threadId, ['codex'], 'opus');
      entry.executedIndex = 1;
      pushToWorklist(threadId, ['opus'], 'codex');
      assert.equal(entry.streakPair.count, 2); // warn level
      resetStreak(threadId);
      assert.ok(!entry.streakPair || entry.streakPair.count === 0, 'resetStreak must clear streakPair');
    } finally {
      unregisterWorklist(threadId, entry);
    }
  });

  test('multi-target push (cats.length > 1) does not increment streak', async () => {
    const { registerWorklist, unregisterWorklist, pushToWorklist } = await loadRegistry();
    const threadId = 'test-streak-multi-target';
    const entry = registerWorklist(threadId, ['opus'], 10);
    try {
      pushToWorklist(threadId, ['codex'], 'opus'); // streak=1
      entry.executedIndex = 1;
      // codex→[opus, gemini] — fan-out, not ping-pong
      const result = pushToWorklist(threadId, ['opus', 'gemini'], 'codex');
      assert.ok(!result.warnPingPong, 'multi-target push must not count as streak');
      // streakPair may reset or stay — key invariant: no warn from fan-out
      assert.ok(!entry.streakPair || entry.streakPair.count <= 1, 'fan-out must not accumulate streak');
    } finally {
      unregisterWorklist(threadId, entry);
    }
  });

  test('push without callerCatId does not update streak (initial user→cat routing)', async () => {
    const { registerWorklist, unregisterWorklist, pushToWorklist } = await loadRegistry();
    const threadId = 'test-streak-no-caller';
    const entry = registerWorklist(threadId, ['opus'], 10);
    try {
      const result = pushToWorklist(threadId, ['codex']); // no caller = not A2A
      assert.deepEqual(result.added, ['codex']);
      assert.ok(!entry.streakPair, 'push without caller must not initialize streakPair');
    } finally {
      unregisterWorklist(threadId, entry);
    }
  });
});
