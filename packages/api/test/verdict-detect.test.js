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

  test('detects approve / approved', () => {
    assert.equal(hasReviewVerdict('I approve this change'), true);
    assert.equal(hasReviewVerdict('approved'), true);
    assert.equal(hasReviewVerdict('APPROVE'), true);
  });

  test('detects reject / rejected', () => {
    assert.equal(hasReviewVerdict('reject this'), true);
    assert.equal(hasReviewVerdict('rejected due to P1'), true);
  });

  test('detects P1 / P2 priority flags', () => {
    assert.equal(hasReviewVerdict('P1: logic bug in handler'), true);
    assert.equal(hasReviewVerdict('found P2 in the wire-up'), true);
    assert.equal(hasReviewVerdict('P0/P1/P2 all clean'), true);
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
    // line-start `@co-creator` (legitimate ball-pass to 铲屎官) gets flagged as
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

  test('verdict + co-creator line-start (Chinese 铲屎官) → false (CJK co-creator handle)', () => {
    assert.equal(
      shouldWarnVerdictWithoutPass({
        text: 'P1 已修\n\n@铲屎官',
        lineStartMentions: [],
        toolNames: [],
        structuredTargetCats: [],
        hasCoCreatorLineStartMention: true,
      }),
      false,
    );
  });
});
