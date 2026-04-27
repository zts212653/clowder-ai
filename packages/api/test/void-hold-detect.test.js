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
import { hasHoldTextClaim, shouldWarnVoidHold } from '../dist/domains/cats/services/agents/routing/void-hold-detect.js';

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
      shouldWarnVoidHold({ ...base, text: '我不持球，升级给铲屎官\n@co-creator', hasCoCreatorLineStartMention: true }),
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
