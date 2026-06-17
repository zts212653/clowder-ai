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
});
