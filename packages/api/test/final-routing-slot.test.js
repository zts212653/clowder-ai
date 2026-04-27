/**
 * F167 Phase H AC-H1~H3/H5/H6 — final routing slot syntax validator (pure function).
 *
 * KD-24：slot 机械校验 + 零 intent 分类器。validator 只看"出口槽位语法对不对"，
 * 不推断"猫想不想传球"。命中只产 invalid_route_syntax；结构边界豁免，禁止语义豁免表。
 *
 * 此处只测纯函数；系统消息广播走 route-serial 集成路径（Task 2）。
 */

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
  finalRoutingSlot,
  findInlineMentionsInSlot,
  validateRoutingSyntax,
} from '../dist/domains/cats/services/agents/routing/final-routing-slot.js';

const roster = ['codex', 'opus', 'gpt52', 'gemini'];

describe('F167 Phase H AC-H1: finalRoutingSlot', () => {
  test('returns last non-empty paragraph', () => {
    const msg = '第一段。\n\n中间段。\n\n最后交接段 @codex';
    assert.equal(finalRoutingSlot(msg), '最后交接段 @codex');
  });

  test('strips fenced code block before selecting slot', () => {
    const msg = '交接给别人：\n\n```bash\necho @codex\n```';
    const slot = finalRoutingSlot(msg);
    assert.equal(slot, '交接给别人：');
    assert.ok(!slot.includes('@codex'));
  });

  test('strips blockquote lines', () => {
    const msg = '我的结论。\n\n> 铲屎官原话 @opus';
    const slot = finalRoutingSlot(msg);
    assert.equal(slot, '我的结论。');
  });

  test('strips URLs (http/https bare links)', () => {
    const msg = '方案清楚。\n\nhttps://x.com/@codex 供参考。';
    const slot = finalRoutingSlot(msg);
    assert.ok(!slot.includes('https://'));
    assert.ok(!slot.includes('@codex'));
  });

  test('empty input returns empty string', () => {
    assert.equal(finalRoutingSlot(''), '');
    assert.equal(finalRoutingSlot('   \n\n  \n'), '');
  });
});

describe('F167 Phase H AC-H2: findInlineMentionsInSlot', () => {
  test('returns non-linestart mention', () => {
    const slot = '让 @codex 看一下';
    assert.deepEqual(findInlineMentionsInSlot(slot, roster), ['codex']);
  });

  test('line-start @ is NOT inline mention', () => {
    const slot = '@codex\n请看';
    assert.deepEqual(findInlineMentionsInSlot(slot, roster), []);
  });

  test('@ after markdown list prefix "- " counts as line-start', () => {
    const slot = '- @codex review';
    assert.deepEqual(findInlineMentionsInSlot(slot, roster), []);
  });

  test('@ after markdown numeric list "1. " counts as line-start', () => {
    const slot = '1. @codex 请看';
    assert.deepEqual(findInlineMentionsInSlot(slot, roster), []);
  });

  test('multiple inline mentions returned in order', () => {
    const slot = '我让 @codex 看了，之后问了 @gpt52';
    assert.deepEqual(findInlineMentionsInSlot(slot, roster), ['codex', 'gpt52']);
  });

  test('handle not in roster ignored', () => {
    const slot = '这是 @unknown 的消息';
    assert.deepEqual(findInlineMentionsInSlot(slot, roster), []);
  });

  test('case-insensitive match — @Codex / @CODEX all detected, normalized to lowercase (cloud P2 fix)', () => {
    // Cloud Codex P2: parseA2AMentions and detectInlineActionMentions both
    // lowercase-normalize; Phase H validator must do the same or miss capitalized
    // handles that routing would still fail on.
    assert.deepEqual(findInlineMentionsInSlot('让 @Codex 看', roster), ['codex']);
    assert.deepEqual(findInlineMentionsInSlot('让 @CODEX 看', roster), ['codex']);
    assert.deepEqual(findInlineMentionsInSlot('让 @Opus 和 @GPT52 看', roster), ['opus', 'gpt52']);
  });

  test('left-boundary guard — foo@codex / bar-codex@codex.ai NOT a mention (cloud P2 round-2)', () => {
    // Cloud Codex round-2 P2: regex must check left boundary too or false-positive
    // on email / package-style tokens like `foo@codex.ai`, `user.codex@codex`.
    // Existing detectInlineActionMentions uses HANDLE_CONTINUATION_RE on prev char;
    // Phase H must do the same.
    assert.deepEqual(findInlineMentionsInSlot('email foo@codex 配置', roster), []);
    assert.deepEqual(findInlineMentionsInSlot('foo@codex.ai 是个域名', roster), []);
    assert.deepEqual(findInlineMentionsInSlot('bar-codex@codex.io 的地址', roster), []);
    // Positive control: punctuation / whitespace before @ is fine → still match
    assert.deepEqual(findInlineMentionsInSlot('请看 @codex', roster), ['codex']);
    assert.deepEqual(findInlineMentionsInSlot('(@codex)', roster), ['codex']);
    assert.deepEqual(findInlineMentionsInSlot('"@codex" 在引号里', roster), ['codex']);
  });
});

describe('F167 Phase H AC-H3: validateRoutingSyntax trigger conditions', () => {
  test('inline @ in slot without legitimate exit → invalid_route_syntax', () => {
    const result = validateRoutingSyntax({
      text: '我让 @codex 看了',
      lineStartMentions: [],
      toolNames: [],
      structuredTargetCats: [],
      rosterHandles: roster,
    });
    assert.equal(result.kind, 'invalid_route_syntax');
    if (result.kind === 'invalid_route_syntax') {
      assert.deepEqual(result.inlineMentions, ['codex']);
    }
  });

  test('legitimate line-start @ exit suppresses invalid_route_syntax', () => {
    const result = validateRoutingSyntax({
      text: '总结我让 @codex 看过了\n\n@codex review',
      lineStartMentions: ['codex'],
      toolNames: [],
      structuredTargetCats: [],
      rosterHandles: roster,
    });
    assert.equal(result.kind, 'ok');
  });

  test('hold_ball tool call exit suppresses invalid_route_syntax', () => {
    const result = validateRoutingSyntax({
      text: '等 @codex 完成再继续',
      lineStartMentions: [],
      toolNames: ['mcp__cat-cafe__cat_cafe_hold_ball'],
      structuredTargetCats: [],
      rosterHandles: roster,
    });
    assert.equal(result.kind, 'ok');
  });

  test('MCP targetCats routing exit suppresses invalid_route_syntax', () => {
    const result = validateRoutingSyntax({
      text: '让 @codex 看',
      lineStartMentions: [],
      toolNames: [],
      structuredTargetCats: ['codex'],
      rosterHandles: roster,
    });
    assert.equal(result.kind, 'ok');
  });
});

describe('F167 Phase H AC-H6: structural exemptions', () => {
  test('inline @ in non-slot (non-last) paragraph does NOT trigger', () => {
    const result = validateRoutingSyntax({
      text: '先前我让 @codex 看过。\n\n现在继续下一步。',
      lineStartMentions: [],
      toolNames: [],
      structuredTargetCats: [],
      rosterHandles: roster,
    });
    assert.equal(result.kind, 'ok');
  });

  test('@ inside fenced code block does NOT trigger', () => {
    const result = validateRoutingSyntax({
      text: '示例调用：\n\n```\necho "@codex review"\n```',
      lineStartMentions: [],
      toolNames: [],
      structuredTargetCats: [],
      rosterHandles: roster,
    });
    assert.equal(result.kind, 'ok');
  });

  test('@ inside blockquote does NOT trigger', () => {
    const result = validateRoutingSyntax({
      text: '> 我问过 @codex',
      lineStartMentions: [],
      toolNames: [],
      structuredTargetCats: [],
      rosterHandles: roster,
    });
    assert.equal(result.kind, 'ok');
  });

  test('@ inside URL does NOT trigger', () => {
    const result = validateRoutingSyntax({
      text: '见 https://github.com/@codex/repo 的说明',
      lineStartMentions: [],
      toolNames: [],
      structuredTargetCats: [],
      rosterHandles: roster,
    });
    assert.equal(result.kind, 'ok');
  });

  test('empty text does NOT trigger', () => {
    const result = validateRoutingSyntax({
      text: '',
      lineStartMentions: [],
      toolNames: [],
      structuredTargetCats: [],
      rosterHandles: roster,
    });
    assert.equal(result.kind, 'ok');
  });
});
