/**
 * F167 Phase I AC-I1~I3 — void hold detection (声明-动作一致性).
 *
 * 场景：猫文本里声明"持球"但本轮 tool_calls 不含 cat_cafe_hold_ball →
 * 虚空持球（文字声明无机械效果）。
 *
 * 只测纯检测函数；系统消息广播走 route-serial 集成路径。
 * 原则（KD-25）：声明-动作一致性 ≠ 语义分类器（KD-8 safe）。
 */

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
  evaluateVoidHold,
  HOLD_PATTERN_IDS,
  hasHoldTextClaim,
  shouldWarnVoidHold,
} from '../dist/domains/cats/services/agents/routing/void-hold-detect.js';

describe('F167 Phase I AC-I1: hasHoldTextClaim', () => {
  test('detects 持球 in plain text', () => {
    assert.equal(hasHoldTextClaim('我持球中，等云端 review'), true);
    assert.equal(hasHoldTextClaim('持球等待唤醒'), true);
  });

  test('detects hold ball / hold_ball (case-insensitive)', () => {
    assert.equal(hasHoldTextClaim('I will hold ball for now'), true);
    assert.equal(hasHoldTextClaim('using hold_ball to wait'), true);
    assert.equal(hasHoldTextClaim('Hold Ball for cloud review'), true);
  });

  test('detects cat_cafe_hold_ball reference in text', () => {
    assert.equal(hasHoldTextClaim('调用 cat_cafe_hold_ball 持球'), true);
  });

  test('does not trigger on empty or unrelated text', () => {
    assert.equal(hasHoldTextClaim(''), false);
    assert.equal(hasHoldTextClaim('review 完成，LGTM'), false);
    assert.equal(hasHoldTextClaim('我来接球继续做'), false);
  });

  // AC-I2: structural exemptions
  test('does not trigger inside fenced code blocks', () => {
    const text = '看这段代码：\n```\n持球等待\n```\n以上是示例';
    assert.equal(hasHoldTextClaim(text), false);
  });

  test('does not trigger inside blockquote', () => {
    const text = '引用之前的讨论：\n> 我持球中\n\n我已经传球了';
    assert.equal(hasHoldTextClaim(text), false);
  });

  test('does not trigger inside URLs', () => {
    const text = '参考 https://example.com/hold-ball-docs 这个链接';
    assert.equal(hasHoldTextClaim(text), false);
  });

  test('triggers when hold text is outside structural exemptions', () => {
    const text = '```\ncode\n```\n\n我持球等云端 review';
    assert.equal(hasHoldTextClaim(text), true);
  });
});

const base = {
  toolNames: [],
  lineStartMentions: [],
  structuredTargetCats: [],
  hasCoCreatorLineStartMention: false,
};

describe('F167 Phase I AC-I1: shouldWarnVoidHold', () => {
  test('warns when text says hold but no tool call and no exit', () => {
    assert.equal(
      shouldWarnVoidHold({
        ...base,
        text: '我持球等云端 codex review',
        toolNames: ['mcp__cat-cafe__cat_cafe_post_message'],
      }),
      true,
    );
  });

  test('does not warn when hold_ball tool was called', () => {
    assert.equal(
      shouldWarnVoidHold({
        ...base,
        text: '我持球等云端 codex review',
        toolNames: ['mcp__cat-cafe__cat_cafe_hold_ball'],
      }),
      false,
    );
  });

  test('does not warn when text has no hold claim', () => {
    assert.equal(shouldWarnVoidHold({ ...base, text: 'review 完成 LGTM' }), false);
  });

  test('does not warn on empty text', () => {
    assert.equal(shouldWarnVoidHold({ ...base, text: '' }), false);
  });

  test('accepts provider-wrapped hold_ball tool name', () => {
    assert.equal(
      shouldWarnVoidHold({ ...base, text: '我持球中', toolNames: ['mcp__cat-cafe-collab__cat_cafe_hold_ball'] }),
      false,
    );
  });

  // P1 fix: legitimate exit exemptions (砚砚 review)
  test('does not warn when line-start @mention exists (already passing ball)', () => {
    assert.equal(
      shouldWarnVoidHold({ ...base, text: '我不持球，直接传球\n@opus', lineStartMentions: ['opus'] }),
      false,
    );
  });

  test('does not warn when structured targetCats exist', () => {
    assert.equal(
      shouldWarnVoidHold({ ...base, text: '这不是持球，是把球传给 reviewer', structuredTargetCats: ['codex'] }),
      false,
    );
  });

  test('does not warn when co-creator mention exists (@co-creator)', () => {
    assert.equal(
      shouldWarnVoidHold({
        ...base,
        text: '我不持球，升级给co-creator\n@co-creator',
        hasCoCreatorLineStartMention: true,
      }),
      false,
    );
  });

  test('still warns when hold text present but exits are all empty', () => {
    assert.equal(
      shouldWarnVoidHold({ ...base, text: '我持球等一下', lineStartMentions: [], structuredTargetCats: [] }),
      true,
    );
  });
});

// F192 Phase D — eval:a2a 2026-06-10 build verdict: per-fire sample evidence.
// `evaluateVoidHold` returns the matched HOLD_PATTERN id as `trigger` so attribution
// can bucket fires by which surface phrase caused detection (parallel to verdict-detect
// returning matched verdict keyword).
describe('F167 Phase I + F192 D: evaluateVoidHold (trigger capture)', () => {
  test('HOLD_PATTERN_IDS exports a stable, non-empty id list', () => {
    assert.ok(Array.isArray(HOLD_PATTERN_IDS));
    assert.ok(HOLD_PATTERN_IDS.length >= 4);
    // Stable contract — every id must be a non-empty string
    for (const id of HOLD_PATTERN_IDS) {
      assert.equal(typeof id, 'string');
      assert.ok(id.length > 0);
    }
  });

  test('returns shouldEmit=false + matchedPattern=null when no hold claim', () => {
    const r = evaluateVoidHold({ ...base, text: 'review 完成 LGTM' });
    assert.equal(r.shouldEmit, false);
    assert.equal(r.matchedPattern, null);
  });

  test('returns shouldEmit=false + matchedPattern=null on empty text', () => {
    const r = evaluateVoidHold({ ...base, text: '' });
    assert.equal(r.shouldEmit, false);
    assert.equal(r.matchedPattern, null);
  });

  test('cn_chiqiu trigger: bare 持球 with no exit', () => {
    const r = evaluateVoidHold({ ...base, text: '持球等待唤醒' });
    assert.equal(r.shouldEmit, true);
    assert.equal(r.matchedPattern, 'cn_chiqiu');
  });

  test('cn_wo_chi_qiu trigger: 我...持...球 with split words takes precedence over cn_chiqiu', () => {
    // Implementation must order more-specific Chinese phrase before bare 持球.
    const r = evaluateVoidHold({ ...base, text: '我现在持着球，等一会' });
    assert.equal(r.shouldEmit, true);
    assert.equal(r.matchedPattern, 'cn_wo_chi_qiu');
  });

  test('en_holdball_space trigger: hold ball (space)', () => {
    const r = evaluateVoidHold({ ...base, text: 'I will hold ball for now' });
    assert.equal(r.shouldEmit, true);
    assert.equal(r.matchedPattern, 'en_holdball_space');
  });

  test('en_hold_ball_underscore trigger: hold_ball (underscore)', () => {
    const r = evaluateVoidHold({ ...base, text: 'using hold_ball to wait' });
    assert.equal(r.shouldEmit, true);
    assert.equal(r.matchedPattern, 'en_hold_ball_underscore');
  });

  test('en_holding_the_ball trigger: holding the ball', () => {
    const r = evaluateVoidHold({ ...base, text: 'just holding the ball briefly' });
    assert.equal(r.shouldEmit, true);
    assert.equal(r.matchedPattern, 'en_holding_the_ball');
  });

  test('mcp_tool_name trigger: cat_cafe_hold_ball mention WITHOUT actual tool call', () => {
    // Narrative reference to the function name without invoking the tool —
    // exactly the kind of 虚空持球 surface we want classified separately.
    const r = evaluateVoidHold({ ...base, text: '准备调用 cat_cafe_hold_ball 但还没动' });
    assert.equal(r.shouldEmit, true);
    assert.equal(r.matchedPattern, 'mcp_tool_name');
  });

  test('returns shouldEmit=false but matchedPattern PRESERVED when hold_ball tool was actually called', () => {
    // The trigger still labels which surface phrase appeared (useful for telemetry —
    // shows what the cat wrote), even though emission is suppressed. The reverse
    // (suppression dropping the trigger) would lose information needed for
    // sample-coverage diagnostics.
    const r = evaluateVoidHold({
      ...base,
      text: '我持球等云端 codex review',
      toolNames: ['mcp__cat-cafe__cat_cafe_hold_ball'],
    });
    assert.equal(r.shouldEmit, false);
    assert.notEqual(r.matchedPattern, null);
  });

  test('shouldWarnVoidHold remains backward compatible (returns boolean equal to evaluateVoidHold.shouldEmit)', () => {
    const positive = { ...base, text: '我持球等一下' };
    assert.equal(shouldWarnVoidHold(positive), evaluateVoidHold(positive).shouldEmit);
    const negative = { ...base, text: '我接球继续做' };
    assert.equal(shouldWarnVoidHold(negative), evaluateVoidHold(negative).shouldEmit);
  });

  // ── 2026-06-20 verdict eval:a2a c2 void-hold English false-positive fix ──
  // 06-20 eval showed C2 at 10/122 = 8.2% above 5% floor; 7 sampled fires
  // dominated by `en_hold_ball_underscore` / `en_holdball_space` matching
  // English tool/status prose in narrative body. Same surgery as C2
  // verdict-without-pass: slot-scope detection so narrative mentions of
  // `hold_ball` / `holdball` don't fire unless the actual final routing
  // slot asserts a hold claim. Preserves true positives + per-fire trigger.

  test('06-20 verdict: en_hold_ball_underscore in narrative body + summary slot → no fire', () => {
    const text =
      'I invoked the hold_ball tool earlier this turn to wait for the eval to finish.\n\n' +
      'Eval still running; will check again in 5 minutes.';
    const r = evaluateVoidHold({ ...base, text });
    assert.equal(r.shouldEmit, false, 'tool-citation narrative + summary slot must not fire');
    assert.equal(r.matchedPattern, null, 'slot has no hold phrase — null trigger');
  });

  test('06-20 verdict: en_holdball_space in narrative body + summary slot → no fire', () => {
    const text =
      'The holdball flow scheduled a wake-up at 3pm; I had to fall through to the cancel path because the timer expired.\n\n' +
      'Cleanup complete, moving on.';
    const r = evaluateVoidHold({ ...base, text });
    assert.equal(r.shouldEmit, false, 'holdball narrative mention + cleanup slot must not fire');
    assert.equal(r.matchedPattern, null);
  });

  test('06-20 verdict: true positive — terminal English `hold_ball` claim in slot → still fires', () => {
    const text = 'Ack on the spec.\n\nI am going to hold_ball while we wait for the cloud review.';
    const r = evaluateVoidHold({ ...base, text });
    assert.equal(r.shouldEmit, true, 'real hold claim in final slot must still fire');
    assert.equal(r.matchedPattern, 'en_hold_ball_underscore');
  });

  test('06-20 verdict: true positive — terminal `holdball` (space-style) in slot → still fires', () => {
    const text = 'Plan looks solid.\n\nGoing to hold ball until I get the eval result.';
    const r = evaluateVoidHold({ ...base, text });
    assert.equal(r.shouldEmit, true, 'space-style hold ball claim in final slot must still fire');
    assert.equal(r.matchedPattern, 'en_holdball_space');
  });

  test('06-20 verdict: signature stripping + narrative `hold_ball` mention → no fire', () => {
    // Signed message ending with `[宪宪/Opus-47🐾]` — signature stripped,
    // then slot picker lands on the actual final paragraph (cleanup summary),
    // not the narrative `hold_ball` mention above.
    const text =
      'I invoked hold_ball in the prior turn but the wake fired already.\n\n' +
      'Status: ready to continue.\n\n' +
      '[宪宪/Opus-47🐾]';
    const r = evaluateVoidHold({ ...base, text });
    assert.equal(r.shouldEmit, false, 'sig-stripped slot is status, not hold claim');
    assert.equal(r.matchedPattern, null);
  });

  test('06-20 verdict: signature stripping + terminal hold claim in last content paragraph → fires', () => {
    const text = 'Ack.\n\nGoing to hold_ball until alpha is ready.\n\n[宪宪/Opus-47🐾]';
    const r = evaluateVoidHold({ ...base, text });
    assert.equal(r.shouldEmit, true);
    assert.equal(r.matchedPattern, 'en_hold_ball_underscore');
  });

  test('06-20 verdict: en_hold_ball_underscore in fenced code at end → slot strips, no fire', () => {
    // Trailing fenced code block — `finalRoutingSlot` strips it, the slot
    // falls back to the prior content paragraph (status).
    const text =
      'See the example call below; this is documentation:\n\n```\nawait cat_cafe_hold_ball({...})\nhold_ball returns a task id\n```';
    const r = evaluateVoidHold({ ...base, text });
    assert.equal(r.shouldEmit, false, 'hold phrase only in trailing fenced code → not a new claim');
  });

  test('06-20 verdict: hold phrase in blockquote of cited prior message → no fire', () => {
    // Cited prior cat's message in blockquote. Slot picker should not see it.
    const text =
      '> Spark said: I am going to hold_ball until the report is done.\n\n' +
      'I think we should send a verdict ping instead.';
    const r = evaluateVoidHold({ ...base, text });
    assert.equal(r.shouldEmit, false, 'blockquote-cited hold claim is not the current cat asserting hold');
    assert.equal(r.matchedPattern, null);
  });

  test('06-20 verdict: single-paragraph terminal claim with all exits absent → fires (true positive control)', () => {
    const text = 'Going to hold_ball now while we wait.';
    const r = evaluateVoidHold({ ...base, text });
    assert.equal(r.shouldEmit, true);
    assert.equal(r.matchedPattern, 'en_hold_ball_underscore');
  });

  test('06-20 verdict: verdict-detect cross-bleed — review verdict in slot does NOT trigger void-hold', () => {
    // Sanity that the slot-scoping doesn't cross-fire on verdict words.
    const text = 'PR looks clean.\n\nLGTM, merging now.';
    const r = evaluateVoidHold({ ...base, text });
    assert.equal(r.shouldEmit, false, 'no hold phrase in slot → matchedPattern null');
    assert.equal(r.matchedPattern, null);
  });

  // PR #2442 round-evolution regression tests (cloud R1 file-path FPs through
  // 砚砚 R7 P2 CJK semantic labels) live in `void-hold-detect-pr2442.test.js`
  // — split per cloud R6/R7/R8 P1 (file 350-line hard cap from AGENTS.md).
});
