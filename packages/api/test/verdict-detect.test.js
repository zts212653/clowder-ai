/**
 * F167 C2 AC-C7 — harness-layer review verdict detection (pure function).
 *
 * 场景：reviewer 输出里给了结论（approve/reject/LGTM/P1/P2/修改建议 等），
 * 但没有行首 @mention，也没调 hold_ball → 球掉地上了。
 *
 * 此处只测纯检测函数；系统消息广播走 route-serial 集成路径。
 * 原则：prompt-first 非阻断。false positive 只是温和提示，不影响链路。
 */

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
  detectMatchedVerdictKeyword,
  hasHoldBallCall,
  hasReviewVerdict,
  shouldWarnVerdictWithoutPass,
} from '../dist/domains/cats/services/agents/routing/verdict-detect.js';

describe('F167 C2 AC-C7: hasReviewVerdict', () => {
  test('detects LGTM (case-insensitive)', () => {
    assert.equal(hasReviewVerdict('LGTM, ready to merge'), true);
    assert.equal(hasReviewVerdict('lgtm'), true);
    assert.equal(hasReviewVerdict('Lgtm!'), true);
  });

  test('detects "approved" (past tense — the decision-made form, 2026-06-05 tuning)', () => {
    assert.equal(hasReviewVerdict('approved'), true);
    assert.equal(hasReviewVerdict('Approved with caveats'), true);
    assert.equal(hasReviewVerdict('approved by reviewer'), true);
    assert.equal(hasReviewVerdict('APPROVED'), true);
  });

  test('does NOT trigger on bare "approve" / "approves" / "APPROVE" (intent, not decision, 2026-06-05 tuning)', () => {
    // Tightened from `/\bapprove(d|s)?\b/i` to `/\bapproved\b/i` because the build
    // observability (#2058 → 2026-06-05 eval) showed bare `approve` dominated
    // false-positive fires (intent statements in working messages, not actual verdicts).
    assert.equal(hasReviewVerdict('I approve this approach'), false);
    assert.equal(hasReviewVerdict('the team approves the design'), false);
    assert.equal(hasReviewVerdict('APPROVE'), false);
  });

  test('detects reject / rejected', () => {
    assert.equal(hasReviewVerdict('reject this'), true);
    assert.equal(hasReviewVerdict('rejected due to spec mismatch'), true);
    // P1 alone without colon no longer matches — but `rejected` still does (verb-form match).
    assert.equal(hasReviewVerdict('rejected with P1 finding'), true);
  });

  test('detects P1: / P2: with colon (classic verdict format, 2026-06-05 tuning)', () => {
    assert.equal(hasReviewVerdict('P1: logic bug in handler'), true);
    assert.equal(hasReviewVerdict('P2: nit on naming'), true);
    assert.equal(hasReviewVerdict('P1 : with space before colon'), true);
    assert.equal(hasReviewVerdict('P2：中文冒号'), true);
  });

  test('does NOT trigger on bare "P1" / "P2" mentions without colon (2026-06-05 tuning)', () => {
    // Tightened from `/\bP[12]\b/` to `/\bP[12]\s*[:：]/` — bare mentions are usually
    // status updates / list items / narrative, not verdicts. Real verdicts use `P1:`.
    assert.equal(hasReviewVerdict('P1 already fixed'), false);
    assert.equal(hasReviewVerdict('found P2 in the wire-up'), false);
    assert.equal(hasReviewVerdict('P0/P1/P2 all clean'), false);
    assert.equal(hasReviewVerdict('PR review with P1 addressed'), false);
  });

  test('detects Chinese verdict keywords', () => {
    assert.equal(hasReviewVerdict('修改建议：重命名 foo'), true);
    assert.equal(hasReviewVerdict('这 PR 可以放行'), true);
    assert.equal(hasReviewVerdict('打回重做'), true);
  });

  test('does NOT trigger on unrelated text', () => {
    assert.equal(hasReviewVerdict('hello world'), false);
    assert.equal(hasReviewVerdict('let me think about this'), false);
    assert.equal(hasReviewVerdict('测试跑完了'), false);
  });

  test('does NOT trigger on "approx" / "approach" (word boundary)', () => {
    assert.equal(hasReviewVerdict('approximately 50 ms'), false);
    assert.equal(hasReviewVerdict('this approach is clean'), false);
  });

  test('does NOT trigger on "P3" / "P4" (only P1/P2)', () => {
    assert.equal(hasReviewVerdict('P3 suggestion only'), false);
    assert.equal(hasReviewVerdict('P0 blocker'), false);
  });
});

describe('F167 C2 AC-C7: detectMatchedVerdictKeyword (F192 build verdict 2026-06-03)', () => {
  // The label name is the *telemetry attribute value* the C2 counters emit. Locked in
  // here so a downstream eval (Prometheus query, attribution) can rely on a stable
  // vocabulary when slicing fires by trigger keyword.
  test('returns "lgtm" for LGTM (case-insensitive)', () => {
    assert.equal(detectMatchedVerdictKeyword('LGTM, ready to merge'), 'lgtm');
    assert.equal(detectMatchedVerdictKeyword('lgtm'), 'lgtm');
  });

  test('returns "approve" only for past tense "approved" (2026-06-05 tuning)', () => {
    assert.equal(detectMatchedVerdictKeyword('approved by reviewer'), 'approve');
    assert.equal(detectMatchedVerdictKeyword('Approved with caveats'), 'approve');
    // Bare present-tense "approve" / "approves" no longer match (intent ≠ decision).
    assert.equal(detectMatchedVerdictKeyword('I approve this change'), null);
    assert.equal(detectMatchedVerdictKeyword('the team approves the design'), null);
  });

  test('returns "reject" for reject / rejected', () => {
    assert.equal(detectMatchedVerdictKeyword('reject this'), 'reject');
    assert.equal(detectMatchedVerdictKeyword('rejected due to spec mismatch'), 'reject');
  });

  test('returns "p1p2" only when P1/P2 is followed by colon (2026-06-05 tuning)', () => {
    assert.equal(detectMatchedVerdictKeyword('P1: logic bug'), 'p1p2');
    assert.equal(detectMatchedVerdictKeyword('P2: nit on naming'), 'p1p2');
    assert.equal(detectMatchedVerdictKeyword('P1：中文冒号'), 'p1p2');
    // Bare mentions without colon no longer match.
    assert.equal(detectMatchedVerdictKeyword('found P2 in handler'), null);
    assert.equal(detectMatchedVerdictKeyword('P1 already addressed'), null);
    assert.equal(detectMatchedVerdictKeyword('P0/P1/P2 all clean'), null);
  });

  test('returns "modify_suggestion" for 修改建议', () => {
    assert.equal(detectMatchedVerdictKeyword('修改建议：重命名 foo'), 'modify_suggestion');
  });

  test('returns "approve_cn" for 放行', () => {
    assert.equal(detectMatchedVerdictKeyword('这 PR 可以放行'), 'approve_cn');
  });

  test('returns "reject_cn" for 打回', () => {
    assert.equal(detectMatchedVerdictKeyword('打回重做'), 'reject_cn');
  });

  test('returns null when no keyword matches', () => {
    assert.equal(detectMatchedVerdictKeyword('hello world'), null);
    assert.equal(detectMatchedVerdictKeyword(''), null);
    assert.equal(detectMatchedVerdictKeyword('approximately 50 ms'), null);
    assert.equal(detectMatchedVerdictKeyword('P3 only'), null);
  });

  test('returns the FIRST match (iteration order, not "most specific")', () => {
    // Locks the contract: if the text matches multiple patterns, the result is the
    // first one in VERDICT_PATTERNS order. Future reorderings would need to update
    // this test and consider how downstream label aggregations would shift.
    assert.equal(detectMatchedVerdictKeyword('LGTM but also P1: finding'), 'lgtm');
    assert.equal(detectMatchedVerdictKeyword('approved with P2: nit'), 'approve');
  });

  test('hasReviewVerdict and detectMatchedVerdictKeyword agree on positives', () => {
    // Consistency between the boolean gate (route-serial uses) and the keyword
    // detector (counter label): same inputs should never disagree on whether the
    // verdict pattern matched. Samples cover the *current* (post-2026-06-05) contract.
    const samples = [
      'LGTM',
      'approved by reviewer',
      'I approve this approach', // bare approve no longer matches
      'reject',
      'P1: finding',
      'found P2 in handler', // no colon → no longer matches
      '修改建议: rename',
      '放行',
      '打回',
      'hello world',
      'P3 only',
    ];
    for (const text of samples) {
      assert.equal(hasReviewVerdict(text), detectMatchedVerdictKeyword(text) !== null, `mismatch on: ${text}`);
    }
  });
});

describe('F167 C2 AC-C7: hasHoldBallCall', () => {
  test('detects cat_cafe_hold_ball in tool names', () => {
    assert.equal(hasHoldBallCall(['cat_cafe_hold_ball']), true);
    assert.equal(hasHoldBallCall(['cat_cafe_post_message', 'cat_cafe_hold_ball']), true);
  });

  test('empty tool names → false', () => {
    assert.equal(hasHoldBallCall([]), false);
  });

  test('other tools only → false', () => {
    assert.equal(hasHoldBallCall(['cat_cafe_post_message', 'cat_cafe_multi_mention']), false);
  });

  test('accepts string prefix cat_cafe_hold_ball* (provider variants)', () => {
    // Some providers wrap MCP tool names with prefixes like mcp__cat-cafe__cat_cafe_hold_ball
    assert.equal(hasHoldBallCall(['mcp__cat-cafe__cat_cafe_hold_ball']), true);
  });
});

describe('F167 C2 AC-C7: shouldWarnVerdictWithoutPass', () => {
  test('verdict + no @ + no hold_ball + no structured routing → true', () => {
    assert.equal(
      shouldWarnVerdictWithoutPass({
        text: 'LGTM, all tests pass',
        lineStartMentions: [],
        toolNames: [],
        structuredTargetCats: [],
      }),
      true,
    );
  });

  test('verdict + has line-start @ → false (ball was passed)', () => {
    assert.equal(
      shouldWarnVerdictWithoutPass({
        text: 'LGTM\n@co-creator review done',
        lineStartMentions: ['you'],
        toolNames: [],
        structuredTargetCats: [],
      }),
      false,
    );
  });

  test('verdict + hold_ball call → false (explicit hold)', () => {
    assert.equal(
      shouldWarnVerdictWithoutPass({
        text: 'P1 found, waiting on CI',
        lineStartMentions: [],
        toolNames: ['cat_cafe_hold_ball'],
        structuredTargetCats: [],
      }),
      false,
    );
  });

  test('verdict + structured routing (post_message.targetCats) → false (MCP ball-pass)', () => {
    assert.equal(
      shouldWarnVerdictWithoutPass({
        text: 'LGTM, review done',
        lineStartMentions: [],
        toolNames: ['cat_cafe_post_message'],
        structuredTargetCats: ['opus'],
      }),
      false,
    );
  });

  test('verdict + structured routing (multi_mention.targets) → false', () => {
    assert.equal(
      shouldWarnVerdictWithoutPass({
        text: '修改建议：重命名 foo',
        lineStartMentions: [],
        toolNames: ['cat_cafe_multi_mention'],
        structuredTargetCats: ['opus', 'gemini'],
      }),
      false,
    );
  });

  test('no verdict keywords → false (even with no @ / no hold)', () => {
    assert.equal(
      shouldWarnVerdictWithoutPass({
        text: 'let me think more before replying',
        lineStartMentions: [],
        toolNames: [],
        structuredTargetCats: [],
      }),
      false,
    );
  });

  test('Chinese verdict + no @ + no hold_ball + no structured routing → true', () => {
    assert.equal(
      shouldWarnVerdictWithoutPass({
        text: '修改建议：重命名 foo → bar',
        lineStartMentions: [],
        toolNames: [],
        structuredTargetCats: [],
      }),
      true,
    );
  });

  test('verdict + inline @ (non line-start) + no structured routing → true', () => {
    // mention in the middle of a line, not line-start → a2aMentions = []
    assert.equal(
      shouldWarnVerdictWithoutPass({
        text: 'LGTM, maybe ask @codex to double check',
        lineStartMentions: [],
        toolNames: [],
        structuredTargetCats: [],
      }),
      true,
    );
  });

  test('verdict + co-creator line-start mention (hasCoCreatorLineStartMention=true) → false (砚砚 GPT-5.5 fix)', () => {
    // 2026-04-25 false-positive root cause: parseA2AMentions only parses cat handles,
    // never returns co-creator handles like 'you'. route-serial passes that empty
    // array to shouldWarnVerdictWithoutPass, so a cat ending its summary report with
    // line-start `@co-creator` (legitimate ball-pass to co-creator) gets flagged as
    // "verdict without pass". Fix: route-serial computes hasCoCreatorLineStartMention
    // via detectUserMention and passes it; shouldWarnVerdictWithoutPass treats it as
    // a legitimate exit.
    assert.equal(
      shouldWarnVerdictWithoutPass({
        text: '放行延续到 abc12345\n\n@co-creator',
        lineStartMentions: [],
        toolNames: [],
        structuredTargetCats: [],
        hasCoCreatorLineStartMention: true,
      }),
      false,
    );
  });

  test('verdict + co-creator NOT line-start (hasCoCreatorLineStartMention=false) + no other exit → true (control)', () => {
    // Control: co-creator flag absent / false → AC-C7 should still fire normally
    assert.equal(
      shouldWarnVerdictWithoutPass({
        text: 'LGTM, ask @co-creator to confirm later',
        lineStartMentions: [],
        toolNames: [],
        structuredTargetCats: [],
        hasCoCreatorLineStartMention: false,
      }),
      true,
    );
  });

  test('verdict + co-creator line-start (Chinese co-creator) → false (CJK co-creator handle)', () => {
    assert.equal(
      shouldWarnVerdictWithoutPass({
        text: 'P1 已修\n\n@co-creator',
        lineStartMentions: [],
        toolNames: [],
        structuredTargetCats: [],
        hasCoCreatorLineStartMention: true,
      }),
      false,
    );
  });
});
