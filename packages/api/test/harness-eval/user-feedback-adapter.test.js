import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { UserFeedbackAdapter } from '../../dist/infrastructure/harness-eval/friction/user-feedback-adapter.js';

// F245 Phase B Task 4 — UserFeedbackAdapter（F222 confirmed issue → FrictionSignal）
// 用 stub store：adapter 是纯映射 + cancel_burst 排除，listConfirmedInWindow 的 Redis 查询行为
// 已在 Task 3 Redis-backed 测过；此处不重测查询模式，只测 transform（stub 返回 FrustrationIssue[]）。

function issue(over = {}) {
  return {
    issueId: 'fi_a',
    status: 'confirmed',
    threadId: 'th-1',
    userId: 'user-a',
    catId: 'opus-48',
    signalType: 'cli_error',
    signalDetail: { reasonCode: 'auth_failed', publicSummary: 'Auth failed' },
    context: { recentMessages: [] },
    createdAt: 1000,
    confirmedAt: 2000,
    ...over,
  };
}

function stubStore(issues, spy) {
  return {
    listConfirmedInWindow: async (sinceMs, untilMs) => {
      if (spy) spy.push([sinceMs, untilMs]);
      return issues;
    },
  };
}

describe('UserFeedbackAdapter (F245 Phase B Task 4)', () => {
  it('channelId is "user-feedback"', () => {
    assert.equal(new UserFeedbackAdapter(stubStore([])).channelId, 'user-feedback');
  });

  it('maps confirmed issue → FrictionSignal with correct fields', async () => {
    const signals = await new UserFeedbackAdapter(
      stubStore([
        issue({
          issueId: 'fi_a',
          signalType: 'cli_error',
          signalDetail: { reasonCode: 'auth_failed', publicSummary: 'Auth failed', toolName: 'Bash' },
          userDescription: 'auth keeps failing',
          confirmedAt: 2000,
        }),
      ]),
    ).pull(0, 9999);

    assert.equal(signals.length, 1);
    const s = signals[0];
    assert.equal(s.id, 'user-feedback:fi_a');
    assert.equal(s.channel, 'user-feedback');
    assert.equal(s.catId, 'opus-48');
    assert.equal(s.threadId, 'th-1');
    assert.equal(s.tool, 'Bash', 'tool 从 signalDetail.toolName(真实字段)提取');
    assert.equal(s.severity, 'high', 'cli_error → high');
    assert.equal(s.symptom, 'cli_error: auth keeps failing', 'userDescription 优先做摘要');
    assert.equal(s.rawRef, 'fi_a');
    assert.equal(s.timestamp, new Date(2000).toISOString(), 'timestamp 取 confirmedAt(窗口列)');
    assert.equal(s.sourceEvidence, 'auth keeps failing');
  });

  it('falls back to signalDetail.publicSummary when no userDescription; omits tool when absent', async () => {
    const [s] = await new UserFeedbackAdapter(
      stubStore([
        issue({ issueId: 'fi_b', userDescription: undefined, signalDetail: { publicSummary: 'Auth failed' } }),
      ]),
    ).pull(0, 9999);
    assert.equal(s.symptom, 'cli_error: Auth failed');
    assert.equal(s.tool, undefined, 'signalDetail 无 tool → omit');
  });

  it('builds per-type discriminating symptom from signalDetail (no userDescription/publicSummary) — cloud R1 P2', async () => {
    // 字段对齐 FrustrationDetector.evaluate 真实 shape；防同类型不同问题塌成一个高频簇（AC-B2 误聚合）
    const cases = [
      ['a2a_timeout', { targetCatId: 'gpt52', elapsedMs: 30000 }, 'a2a_timeout: gpt52'],
      ['retry_burst', { matchCount: 4, repeatedPrefix: 'gh pr checks' }, 'retry_burst: gh pr checks'],
      ['text_frustration', { matchedKeywords: ['卡', '慢'], matchCount: 2 }, 'text_frustration: 卡 慢'],
      ['user_report', { toolName: 'Bash', cancelReason: 'wrong_direction' }, 'user_report: wrong_direction'],
    ];
    for (const [signalType, signalDetail, expectedSymptom] of cases) {
      const [s] = await new UserFeedbackAdapter(
        stubStore([issue({ issueId: `fi_${signalType}`, signalType, userDescription: undefined, signalDetail })]),
      ).pull(0, 9999);
      assert.equal(s.symptom, expectedSymptom, `${signalType} → 判别性 symptom`);
    }
    // 两个不同 a2a_timeout target → 不同 symptom（不塌成一簇）
    const two = await new UserFeedbackAdapter(
      stubStore([
        issue({
          issueId: 'fi_t1',
          signalType: 'a2a_timeout',
          userDescription: undefined,
          signalDetail: { targetCatId: 'gpt52' },
        }),
        issue({
          issueId: 'fi_t2',
          signalType: 'a2a_timeout',
          userDescription: undefined,
          signalDetail: { targetCatId: 'sonnet' },
        }),
      ]),
    ).pull(0, 9999);
    assert.notEqual(two[0].symptom, two[1].symptom, '不同 target 的 a2a_timeout symptom 不同');
  });

  it('gracefully degrades to bare signalType when signalDetail lacks the per-type field', async () => {
    const [s] = await new UserFeedbackAdapter(
      stubStore([issue({ issueId: 'fi_x', signalType: 'a2a_timeout', userDescription: undefined, signalDetail: {} })]),
    ).pull(0, 9999);
    assert.equal(s.symptom, 'a2a_timeout', '缺 targetCatId → 退化 bare signalType（不臆造）');
  });

  it('excludes signalType="cancel_burst" (avoid double-count with cancel channel)', async () => {
    const signals = await new UserFeedbackAdapter(
      stubStore([
        issue({ issueId: 'fi_keep', signalType: 'cli_error' }),
        issue({ issueId: 'fi_drop', signalType: 'cancel_burst', signalDetail: { cancelCount: 4, windowMs: 60000 } }),
      ]),
    ).pull(0, 9999);

    assert.deepEqual(
      signals.map((s) => s.id),
      ['user-feedback:fi_keep'],
      'cancel_burst 被排除',
    );
  });

  it('maps severity by signalType', async () => {
    const types = [
      ['cli_error', 'high'],
      ['a2a_timeout', 'high'],
      ['retry_burst', 'high'],
      ['text_frustration', 'medium'],
      ['user_report', 'medium'],
    ];
    for (const [signalType, expected] of types) {
      const [s] = await new UserFeedbackAdapter(stubStore([issue({ signalType })])).pull(0, 9999);
      assert.equal(s.severity, expected, `${signalType} → ${expected}`);
    }
  });

  it('idempotent: same issues → identical id set across pulls', async () => {
    const adapter = new UserFeedbackAdapter(stubStore([issue({ issueId: 'fi_a' }), issue({ issueId: 'fi_c' })]));
    const first = (await adapter.pull(0, 9999)).map((s) => s.id).sort();
    const second = (await adapter.pull(0, 9999)).map((s) => s.id).sort();
    assert.deepEqual(second, first);
    assert.deepEqual(first, ['user-feedback:fi_a', 'user-feedback:fi_c']);
  });

  it('forwards window to store; empty result → []', async () => {
    const spy = [];
    const out = await new UserFeedbackAdapter(stubStore([], spy)).pull(111, 222);
    assert.deepEqual(out, []);
    assert.deepEqual(spy, [[111, 222]]);
  });
});
