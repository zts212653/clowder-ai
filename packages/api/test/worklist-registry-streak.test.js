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

/**
 * F167 Phase D: isSubstantiveTool — tool_call 作为"干活"的客观信号。
 *
 * 黑名单：cat_cafe_post_message / cat_cafe_multi_mention / cat_cafe_hold_ball
 * 这三个是路由/持球本身（传球/持球工具），不算工作证据。
 * 其他所有 tool（文件 I/O、MCP task、search、git 等）都算实质工作。
 *
 * 兼容 provider 前缀（mcp__cat-cafe__*）— substring 匹配。
 */
describe('F167 Phase D: isSubstantiveTool helper', () => {
  test('routing tools (post_message / multi_mention / hold_ball) are NOT substantive', async () => {
    const { isSubstantiveTool } = await loadRegistry();
    assert.equal(isSubstantiveTool('cat_cafe_post_message'), false);
    assert.equal(isSubstantiveTool('cat_cafe_multi_mention'), false);
    assert.equal(isSubstantiveTool('cat_cafe_hold_ball'), false);
  });

  test('provider-prefixed routing tools are also NOT substantive', async () => {
    const { isSubstantiveTool } = await loadRegistry();
    assert.equal(isSubstantiveTool('mcp__cat-cafe__cat_cafe_post_message'), false);
    assert.equal(isSubstantiveTool('mcp__cat-cafe__cat_cafe_multi_mention'), false);
    assert.equal(isSubstantiveTool('mcp__cat-cafe__cat_cafe_hold_ball'), false);
  });

  test('file/search/task tools are substantive (evidence of real work)', async () => {
    const { isSubstantiveTool } = await loadRegistry();
    assert.equal(isSubstantiveTool('Read'), true);
    assert.equal(isSubstantiveTool('Edit'), true);
    assert.equal(isSubstantiveTool('Write'), true);
    assert.equal(isSubstantiveTool('Grep'), true);
    assert.equal(isSubstantiveTool('Bash'), true);
    assert.equal(isSubstantiveTool('cat_cafe_update_task'), true);
    assert.equal(isSubstantiveTool('cat_cafe_search_evidence'), true);
    assert.equal(isSubstantiveTool('cat_cafe_create_task'), true);
  });

  test('empty string returns false (defensive)', async () => {
    const { isSubstantiveTool } = await loadRegistry();
    assert.equal(isSubstantiveTool(''), false);
  });
});

/**
 * F167 Phase D: updateStreakOnPush with callerActivity.
 *
 * streak 累加条件从"同 pair 连续次数"升级为"同 pair + 猫没干实质活 + 内容短"。
 * 客观坐标系：
 *   - hadSubstantiveToolCall=true   → 干活（豁免）
 *   - outputLength > OUTPUT_LEN_T(200) → 讨论/设计（豁免）
 *   - 两者都否 → 纯语言惯性（streak++）
 *
 * 不传 activity 视为向后兼容——按旧逻辑累加（pushToWorklist 在 Task 3 之前还是不传）。
 */
describe('F167 Phase D: updateStreakOnPush with callerActivity', () => {
  test('substantive tool call every round → streak NOT accumulated (4 rounds, no block)', async () => {
    const { registerWorklist, unregisterWorklist, updateStreakOnPush } = await loadRegistry();
    const threadId = 'test-streak-phaseD-substantive';
    const entry = registerWorklist(threadId, ['opus'], 10);
    try {
      const activity = { hadSubstantiveToolCall: true, outputLength: 50 };
      updateStreakOnPush(entry, 'opus', 'codex', activity);
      updateStreakOnPush(entry, 'codex', 'opus', activity);
      updateStreakOnPush(entry, 'opus', 'codex', activity);
      const r4 = updateStreakOnPush(entry, 'codex', 'opus', activity);
      assert.equal(r4.blockPingPong, false, 'substantive work every round must not trip the breaker');
      assert.equal(r4.count, 1, 'streak stays at 1 when every round is substantive');
    } finally {
      unregisterWorklist(threadId, entry);
    }
  });

  test('no tool + short text → streak accumulates and blocks at 4 (pure language inertia)', async () => {
    const { registerWorklist, unregisterWorklist, updateStreakOnPush } = await loadRegistry();
    const threadId = 'test-streak-phaseD-lazy';
    const entry = registerWorklist(threadId, ['opus'], 10);
    try {
      const activity = { hadSubstantiveToolCall: false, outputLength: 30 };
      updateStreakOnPush(entry, 'opus', 'codex', activity); // 1
      updateStreakOnPush(entry, 'codex', 'opus', activity); // 2 warn
      updateStreakOnPush(entry, 'opus', 'codex', activity); // 3 warn
      const r4 = updateStreakOnPush(entry, 'codex', 'opus', activity); // 4 block
      assert.equal(r4.blockPingPong, true);
      assert.equal(r4.count, 4);
    } finally {
      unregisterWorklist(threadId, entry);
    }
  });

  test('no tool + long text (>200) → streak NOT accumulated (architecture discussion)', async () => {
    const { registerWorklist, unregisterWorklist, updateStreakOnPush } = await loadRegistry();
    const threadId = 'test-streak-phaseD-longtext';
    const entry = registerWorklist(threadId, ['opus'], 10);
    try {
      const activity = { hadSubstantiveToolCall: false, outputLength: 500 };
      updateStreakOnPush(entry, 'opus', 'codex', activity);
      updateStreakOnPush(entry, 'codex', 'opus', activity);
      updateStreakOnPush(entry, 'opus', 'codex', activity);
      const r4 = updateStreakOnPush(entry, 'codex', 'opus', activity);
      assert.equal(r4.blockPingPong, false, 'long-text discussion must not trip the breaker');
      assert.equal(r4.count, 1, 'long text is real discussion — no streak accumulation');
    } finally {
      unregisterWorklist(threadId, entry);
    }
  });

  test('P1 (gpt52 review): prior inertia streak is BROKEN by a substantive round', async () => {
    // Scenario: 3 rounds of pure-inertia push (streak=3, warn but not block),
    // then 1 round of substantive work (tool_use / long text), then another
    // short push → must NOT block. Real work must reset the inertia counter,
    // not merely skip incrementing it (otherwise 3+1 substantive+1 short = block).
    const { registerWorklist, unregisterWorklist, updateStreakOnPush } = await loadRegistry();
    const threadId = 'test-streak-phaseD-break-inertia';
    const entry = registerWorklist(threadId, ['opus'], 10);
    try {
      const inertia = { hadSubstantiveToolCall: false, outputLength: 30 };
      const substantive = { hadSubstantiveToolCall: true, outputLength: 30 };

      updateStreakOnPush(entry, 'opus', 'codex', inertia); // 1
      updateStreakOnPush(entry, 'codex', 'opus', inertia); // 2 warn
      updateStreakOnPush(entry, 'opus', 'codex', inertia); // 3 warn
      assert.equal(entry.streakPair.count, 3, 'precondition: streak=3 from inertia');

      updateStreakOnPush(entry, 'codex', 'opus', substantive); // should RESET, not just skip
      assert.equal(entry.streakPair.count, 1, 'substantive round must reset inertia streak to 1');

      const r5 = updateStreakOnPush(entry, 'opus', 'codex', inertia); // next short
      assert.equal(r5.blockPingPong, false, 'after substantive reset, one more inertia push must NOT block');
      assert.equal(r5.count, 2, 'streak restart from new run: 1 (substantive) → 2 (next inertia)');
    } finally {
      unregisterWorklist(threadId, entry);
    }
  });

  test('P1 (cloud Codex review): substantive streak-reset requires actual enqueue — dedup skip must NOT reset', async () => {
    // Reward-hack vector cloud Codex flagged: a long-content callback that
    // targets a cat ALREADY pending in the worklist would still reset a
    // near-blocked streak to 1 via isSubstantiveActivity, even though nothing
    // was actually enqueued. Fix: streak updates only fire on actual push.
    const { registerWorklist, unregisterWorklist, pushToWorklist } = await loadRegistry();
    const threadId = 'test-streak-phaseD-reset-requires-enqueue';
    const entry = registerWorklist(threadId, ['opus'], 10);
    try {
      // Preload streak=3 (pure inertia). Advance executedIndex after each push
      // so caller_mismatch guard passes on the next iteration (current cat = caller).
      const inertia = { hadSubstantiveToolCall: false, outputLength: 30 };
      pushToWorklist(threadId, ['codex'], 'opus', undefined, undefined, inertia);
      entry.executedIndex = 1; // current = 'codex'
      pushToWorklist(threadId, ['opus'], 'codex', undefined, undefined, inertia);
      entry.executedIndex = 2; // current = 'opus'
      pushToWorklist(threadId, ['codex'], 'opus', undefined, undefined, inertia);
      entry.executedIndex = 3; // current = 'codex' (matches next caller)
      assert.equal(entry.streakPair.count, 3, 'precondition: streak=3');
      assert.equal(entry.list[entry.executedIndex], 'codex', 'precondition: current cat is codex');

      // Inject duplicate 'opus' into pending tail so dedup will skip.
      entry.list.push('opus'); // list=[opus, codex, opus, codex, opus]; pending tail=[codex, opus]
      const beforeCount = entry.streakPair.count;

      // Substantive-looking callback from codex → opus. Passes caller check;
      // should hit dedup (opus already in pending); streak MUST NOT reset.
      const substantive = { hadSubstantiveToolCall: false, outputLength: 500 };
      const result = pushToWorklist(threadId, ['opus'], 'codex', undefined, undefined, substantive);

      assert.equal(result.added.length, 0, 'dedup must skip — nothing added');
      assert.equal(
        entry.streakPair.count,
        beforeCount,
        'streak must NOT reset when nothing was actually enqueued (cloud Codex P1)',
      );
    } finally {
      unregisterWorklist(threadId, entry);
    }
  });

  test('P1 (cloud Codex review): streak-increment also requires actual enqueue — depth skip must NOT accumulate', async () => {
    // Symmetric: inertia push that hits depth limit must not count either.
    const { registerWorklist, unregisterWorklist, pushToWorklist } = await loadRegistry();
    const threadId = 'test-streak-phaseD-incr-requires-enqueue';
    const entry = registerWorklist(threadId, ['opus'], 2); // maxDepth=2
    try {
      const inertia = { hadSubstantiveToolCall: false, outputLength: 30 };
      pushToWorklist(threadId, ['codex'], 'opus', undefined, undefined, inertia);
      entry.executedIndex = 1; // current = codex
      pushToWorklist(threadId, ['opus'], 'codex', undefined, undefined, inertia);
      entry.executedIndex = 2; // current = opus
      // a2aCount=2 now at maxDepth — next push would hit depth limit.
      assert.equal(entry.a2aCount, 2, 'precondition: at maxDepth');
      const beforeCount = entry.streakPair.count;

      // opus → gemini push should be depth-skipped (different pair anyway; use gemini to rule out dedup).
      // Intentionally same pair opus↔codex to stress streak ++ vs actual enqueue separation:
      const result = pushToWorklist(threadId, ['codex'], 'opus', undefined, undefined, inertia);
      assert.equal(result.added.length, 0, 'depth limit must skip — nothing added');
      assert.equal(entry.streakPair.count, beforeCount, 'streak must NOT tick when depth guard skipped the enqueue');
    } finally {
      unregisterWorklist(threadId, entry);
    }
  });

  test('no activity arg (backward compat) → legacy accumulation behavior', async () => {
    const { registerWorklist, unregisterWorklist, updateStreakOnPush } = await loadRegistry();
    const threadId = 'test-streak-phaseD-legacy';
    const entry = registerWorklist(threadId, ['opus'], 10);
    try {
      updateStreakOnPush(entry, 'opus', 'codex');
      updateStreakOnPush(entry, 'codex', 'opus');
      updateStreakOnPush(entry, 'opus', 'codex');
      const r4 = updateStreakOnPush(entry, 'codex', 'opus');
      assert.equal(r4.blockPingPong, true, 'omitting activity must keep legacy accumulation behavior');
      assert.equal(r4.count, 4);
    } finally {
      unregisterWorklist(threadId, entry);
    }
  });

  test('pushToWorklist passes callerActivity through to streak (substantive → no block)', async () => {
    const { registerWorklist, unregisterWorklist, pushToWorklist } = await loadRegistry();
    const threadId = 'test-pushToWorklist-activity-substantive';
    const entry = registerWorklist(threadId, ['opus'], 10);
    try {
      const activity = { hadSubstantiveToolCall: true, outputLength: 50 };
      pushToWorklist(threadId, ['codex'], 'opus', undefined, undefined, activity);
      entry.executedIndex = 1;
      pushToWorklist(threadId, ['opus'], 'codex', undefined, undefined, activity);
      entry.executedIndex = 2;
      pushToWorklist(threadId, ['codex'], 'opus', undefined, undefined, activity);
      entry.executedIndex = 3;
      const r = pushToWorklist(threadId, ['opus'], 'codex', undefined, undefined, activity);
      assert.ok(!r.blockPingPong, 'substantive activity via pushToWorklist must not trip breaker after 4 rounds');
    } finally {
      unregisterWorklist(threadId, entry);
    }
  });

  test('pushToWorklist: inertia activity (short text + no tool) → block at round 4', async () => {
    const { registerWorklist, unregisterWorklist, pushToWorklist } = await loadRegistry();
    const threadId = 'test-pushToWorklist-activity-inertia';
    const entry = registerWorklist(threadId, ['opus'], 10);
    try {
      const activity = { hadSubstantiveToolCall: false, outputLength: 30 };
      pushToWorklist(threadId, ['codex'], 'opus', undefined, undefined, activity);
      entry.executedIndex = 1;
      pushToWorklist(threadId, ['opus'], 'codex', undefined, undefined, activity);
      entry.executedIndex = 2;
      pushToWorklist(threadId, ['codex'], 'opus', undefined, undefined, activity);
      entry.executedIndex = 3;
      const r = pushToWorklist(threadId, ['opus'], 'codex', undefined, undefined, activity);
      assert.ok(r.blockPingPong, 'pure inertia via pushToWorklist must still trip breaker');
      assert.equal(r.reason, 'pingpong_terminated');
    } finally {
      unregisterWorklist(threadId, entry);
    }
  });
});
