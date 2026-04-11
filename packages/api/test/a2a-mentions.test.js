/**
 * A2A Mention Detection + Prompt Injection Tests
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { catRegistry } from '@cat-cafe/shared';

describe('parseA2AMentions', () => {
  it('detects line-start @mention (Chinese name)', async () => {
    const { parseA2AMentions } = await import('../dist/domains/cats/services/agents/routing/a2a-mentions.js');
    const result = parseA2AMentions('@缅因猫 请 review 这段代码', 'opus');
    assert.deepEqual(result, ['codex']);
  });

  it('accepts line-start @mention without a separating space (Chinese handle)', async () => {
    const { parseA2AMentions } = await import('../dist/domains/cats/services/agents/routing/a2a-mentions.js');
    const result = parseA2AMentions('@缅因猫请 review 这段代码', 'opus');
    assert.deepEqual(result, ['codex']);
  });

  it('detects line-start @mention with leading whitespace when action words exist', async () => {
    const { parseA2AMentions } = await import('../dist/domains/cats/services/agents/routing/a2a-mentions.js');
    const result = parseA2AMentions('  @布偶猫 请确认这个修复', 'codex');
    assert.deepEqual(result, ['opus']);
  });

  it('routes when action words are in next line of same paragraph', async () => {
    const { parseA2AMentions } = await import('../dist/domains/cats/services/agents/routing/a2a-mentions.js');
    const text = '@布偶猫\n请 review 这个 PR';
    const result = parseA2AMentions(text, 'codex');
    assert.deepEqual(result, ['opus']);
  });

  // === Standalone mention: line-start @mention always routes ===

  it('routes standalone @mention on its own line followed by content (no keywords needed)', async () => {
    const { parseA2AMentions } = await import('../dist/domains/cats/services/agents/routing/a2a-mentions.js');
    const text = '@codex\n砚砚方案如上。你按这个落地就行';
    const result = parseA2AMentions(text, 'opus');
    assert.deepEqual(result, ['codex']);
  });

  it('routes @mention + handoff language without action keywords', async () => {
    const { parseA2AMentions } = await import('../dist/domains/cats/services/agents/routing/a2a-mentions.js');
    const text = '@codex\n下一个你！';
    const result = parseA2AMentions(text, 'opus');
    assert.deepEqual(result, ['codex']);
  });

  it('routes @mention across paragraph boundary (blank line between mention and content)', async () => {
    const { parseA2AMentions } = await import('../dist/domains/cats/services/agents/routing/a2a-mentions.js');
    const text = '@布偶猫\n\n这是交接文档 blah blah';
    const result = parseA2AMentions(text, 'codex');
    assert.deepEqual(result, ['opus']);
  });

  it('routes bare @mention (no other content in message)', async () => {
    const { parseA2AMentions } = await import('../dist/domains/cats/services/agents/routing/a2a-mentions.js');
    const result = parseA2AMentions('@布偶猫', 'codex');
    assert.deepEqual(result, ['opus']);
  });

  it('routes @mention with arbitrary text on same line (no keyword match)', async () => {
    const { parseA2AMentions } = await import('../dist/domains/cats/services/agents/routing/a2a-mentions.js');
    const result = parseA2AMentions('@布偶猫 prefix typo', 'codex');
    assert.deepEqual(result, ['opus']);
  });

  it('routes multiple @mentions across paragraphs', async () => {
    const { parseA2AMentions } = await import('../dist/domains/cats/services/agents/routing/a2a-mentions.js');
    const text = '@布偶猫\n@缅因猫\n\n这是交接给你们的';
    const result = parseA2AMentions(text, 'gpt52');
    assert.deepEqual(result, ['opus', 'codex']);
  });

  it('routes multiple @mentions on the same line when the line is a pure handoff target list', async () => {
    const { parseA2AMentions } = await import('../dist/domains/cats/services/agents/routing/a2a-mentions.js');
    const { loadCatConfig, toAllCatConfigs } = await import('../dist/config/cat-config-loader.js');

    const originalConfigs = catRegistry.getAllConfigs();
    catRegistry.reset();
    try {
      const runtimeConfigs = toAllCatConfigs(loadCatConfig());
      for (const [id, config] of Object.entries(runtimeConfigs)) {
        catRegistry.register(id, config);
      }

      const text = '到我这里结束了吗？是的 — 我的编译修复已完成，等待 commit + push 和 CI 结果。\n@opus @gpt52';
      const result = parseA2AMentions(text, 'kimi');
      assert.deepEqual(result, ['opus', 'gpt52']);
    } finally {
      catRegistry.reset();
      for (const [id, config] of Object.entries(originalConfigs)) {
        catRegistry.register(id, config);
      }
    }
  });

  it('does not treat later inline mentions as actionable once prose starts on the line', async () => {
    const { parseA2AMentions } = await import('../dist/domains/cats/services/agents/routing/a2a-mentions.js');
    const { loadCatConfig, toAllCatConfigs } = await import('../dist/config/cat-config-loader.js');

    const originalConfigs = catRegistry.getAllConfigs();
    catRegistry.reset();
    try {
      const runtimeConfigs = toAllCatConfigs(loadCatConfig());
      for (const [id, config] of Object.entries(runtimeConfigs)) {
        catRegistry.register(id, config);
      }

      const text = '@opus 请继续推进，如果需要再找 @gpt52';
      const result = parseA2AMentions(text, 'kimi');
      assert.deepEqual(result, ['opus']);
    } finally {
      catRegistry.reset();
      for (const [id, config] of Object.entries(originalConfigs)) {
        catRegistry.register(id, config);
      }
    }
  });

  // === Content-before-mention: 上文写内容，最后一行 @ (缅因猫习惯) ===

  it('routes when content comes before @mention (content-before-mention pattern)', async () => {
    const { parseA2AMentions } = await import('../dist/domains/cats/services/agents/routing/a2a-mentions.js');
    const text = '这是交接文档，DARE 源码目录执行 + 业务项目 workspace\n是否接受完全禁用 --api-key argv\n@opus';
    const result = parseA2AMentions(text, 'codex');
    assert.deepEqual(result, ['opus']);
  });

  it('routes line-start @mention after markdown numbered-list prefix', async () => {
    const { parseA2AMentions } = await import('../dist/domains/cats/services/agents/routing/a2a-mentions.js');
    const text = '1. @codex 帮忙看下这个实现';
    const result = parseA2AMentions(text, 'kimi');
    assert.deepEqual(result, ['codex']);
  });

  it('routes line-start @mention after markdown bullet prefix', async () => {
    const { parseA2AMentions } = await import('../dist/domains/cats/services/agents/routing/a2a-mentions.js');
    const text = '- @codex please review this patch';
    const result = parseA2AMentions(text, 'opus');
    assert.deepEqual(result, ['codex']);
  });

  it('routes line-start @mention after markdown quote prefix', async () => {
    const { parseA2AMentions } = await import('../dist/domains/cats/services/agents/routing/a2a-mentions.js');
    const text = '> @gemini 看下这个视觉方案';
    const result = parseA2AMentions(text, 'codex');
    assert.deepEqual(result, ['gemini']);
  });

  it('matches markdown-style .md suffix handles emitted by Kimi', async () => {
    const { parseA2AMentions } = await import('../dist/domains/cats/services/agents/routing/a2a-mentions.js');
    const text = '@KIMI.md 这个给你继续';
    const result = parseA2AMentions(text, 'opus');
    assert.deepEqual(result, ['kimi']);
  });

  it('analyzeA2AMentions returns empty suppressed (no suppression system)', async () => {
    const { analyzeA2AMentions } = await import('../dist/domains/cats/services/agents/routing/a2a-mentions.js');
    const result = analyzeA2AMentions('@布偶猫', 'codex');
    assert.deepEqual(result.mentions, ['opus']);
    assert.deepEqual(result.suppressed, []);
  });

  // === Backward compat: mode option is accepted but ignored ===

  it('mode option is accepted but does not affect routing (backward compat)', async () => {
    const { parseA2AMentions } = await import('../dist/domains/cats/services/agents/routing/a2a-mentions.js');
    const text = '@布偶猫\n\n这是交接文档';
    const strict = parseA2AMentions(text, 'codex', { mode: 'strict' });
    const relaxed = parseA2AMentions(text, 'codex', { mode: 'relaxed' });
    assert.deepEqual(strict, ['opus']);
    assert.deepEqual(relaxed, ['opus']);
  });

  it('does NOT trigger for non-line-start @mention', async () => {
    const { parseA2AMentions } = await import('../dist/domains/cats/services/agents/routing/a2a-mentions.js');
    const result = parseA2AMentions('之前布偶猫说的 @布偶猫 方案不错', 'codex');
    assert.deepEqual(result, []);
  });

  it('ignores @mention inside fenced code blocks', async () => {
    const { parseA2AMentions } = await import('../dist/domains/cats/services/agents/routing/a2a-mentions.js');
    const text = '看看这段代码：\n```\n@缅因猫 请review\n```\n没问题';
    const result = parseA2AMentions(text, 'opus');
    assert.deepEqual(result, []);
  });

  it('filters self-mention', async () => {
    const { parseA2AMentions } = await import('../dist/domains/cats/services/agents/routing/a2a-mentions.js');
    const result = parseA2AMentions('@布偶猫 我自己说的', 'opus');
    assert.deepEqual(result, []);
  });

  it('F27: returns all matches (multi-mention, up to 2)', async () => {
    const { parseA2AMentions } = await import('../dist/domains/cats/services/agents/routing/a2a-mentions.js');
    // Both on separate lines — F27 returns both
    const text = '@缅因猫 先review\n@暹罗猫 再看看设计';
    const result = parseA2AMentions(text, 'opus');
    assert.equal(result.length, 2);
    assert.ok(result.includes('codex'));
    assert.ok(result.includes('gemini'));
  });

  it('returns empty array for empty text', async () => {
    const { parseA2AMentions } = await import('../dist/domains/cats/services/agents/routing/a2a-mentions.js');
    assert.deepEqual(parseA2AMentions('', 'opus'), []);
  });

  it('matches English mention patterns', async () => {
    const { parseA2AMentions } = await import('../dist/domains/cats/services/agents/routing/a2a-mentions.js');
    const result = parseA2AMentions('@codex please review', 'opus');
    assert.deepEqual(result, ['codex']);
  });

  it('accepts line-start @mention without a separating space (English handle + CJK)', async () => {
    const { parseA2AMentions } = await import('../dist/domains/cats/services/agents/routing/a2a-mentions.js');
    const result = parseA2AMentions('@codex请看', 'opus');
    assert.deepEqual(result, ['codex']);
  });

  it('matches gpt52 variant alias @gpt5.2 from runtime cat-config', async () => {
    const { parseA2AMentions } = await import('../dist/domains/cats/services/agents/routing/a2a-mentions.js');
    const { loadCatConfig, toAllCatConfigs } = await import('../dist/config/cat-config-loader.js');

    const originalConfigs = catRegistry.getAllConfigs();
    catRegistry.reset();
    try {
      const runtimeConfigs = toAllCatConfigs(loadCatConfig());
      for (const [id, config] of Object.entries(runtimeConfigs)) {
        catRegistry.register(id, config);
      }

      const result = parseA2AMentions('@gpt5.2 帮忙看下', 'codex');
      assert.deepEqual(result, ['gpt52']);
    } finally {
      catRegistry.reset();
      for (const [id, config] of Object.entries(originalConfigs)) {
        catRegistry.register(id, config);
      }
    }
  });

  it('matches stable @gpt alias for gpt52 from runtime cat-config', async () => {
    const { parseA2AMentions } = await import('../dist/domains/cats/services/agents/routing/a2a-mentions.js');
    const { loadCatConfig, toAllCatConfigs } = await import('../dist/config/cat-config-loader.js');

    const originalConfigs = catRegistry.getAllConfigs();
    catRegistry.reset();
    try {
      const runtimeConfigs = toAllCatConfigs(loadCatConfig());
      for (const [id, config] of Object.entries(runtimeConfigs)) {
        catRegistry.register(id, config);
      }

      const result = parseA2AMentions('@gpt 帮忙看下', 'codex');
      assert.deepEqual(result, ['gpt52']);
    } finally {
      catRegistry.reset();
      for (const [id, config] of Object.entries(originalConfigs)) {
        catRegistry.register(id, config);
      }
    }
  });

  it('does not prefix-match variant handles (@opus-45 should not match @opus)', async () => {
    const { parseA2AMentions } = await import('../dist/domains/cats/services/agents/routing/a2a-mentions.js');
    const { loadCatConfig, toAllCatConfigs } = await import('../dist/config/cat-config-loader.js');

    const originalConfigs = catRegistry.getAllConfigs();
    catRegistry.reset();
    try {
      const runtimeConfigs = toAllCatConfigs(loadCatConfig());
      for (const [id, config] of Object.entries(runtimeConfigs)) {
        catRegistry.register(id, config);
      }

      const result = parseA2AMentions('@opus-45 请看', 'gpt52');
      assert.deepEqual(result, ['opus-45']);
    } finally {
      catRegistry.reset();
      for (const [id, config] of Object.entries(originalConfigs)) {
        catRegistry.register(id, config);
      }
    }
  });

  it('keeps true first two targets without prefix collision side effects', async () => {
    const { parseA2AMentions } = await import('../dist/domains/cats/services/agents/routing/a2a-mentions.js');
    const { loadCatConfig, toAllCatConfigs } = await import('../dist/config/cat-config-loader.js');

    const originalConfigs = catRegistry.getAllConfigs();
    catRegistry.reset();
    try {
      const runtimeConfigs = toAllCatConfigs(loadCatConfig());
      for (const [id, config] of Object.entries(runtimeConfigs)) {
        catRegistry.register(id, config);
      }

      const text = '@opus-45 请看一下\n@gemini25 please review';
      const result = parseA2AMentions(text, 'gpt52');
      assert.deepEqual(result, ['opus-45', 'gemini25']);
    } finally {
      catRegistry.reset();
      for (const [id, config] of Object.entries(originalConfigs)) {
        catRegistry.register(id, config);
      }
    }
  });
});

describe('F052: cross-thread self-reference exemption', () => {
  it('parseA2AMentions with undefined currentCatId does not filter any cat', async () => {
    const { parseA2AMentions } = await import('../dist/domains/cats/services/agents/routing/a2a-mentions.js');
    const result = parseA2AMentions('@codex 请处理这个任务', undefined);
    assert.ok(result.includes('codex'), 'should include codex when currentCatId is undefined');
  });

  it('parseA2AMentions with currentCatId still filters self', async () => {
    const { parseA2AMentions } = await import('../dist/domains/cats/services/agents/routing/a2a-mentions.js');
    const result = parseA2AMentions('@codex 请处理这个任务', 'codex');
    assert.ok(!result.includes('codex'), 'should NOT include codex when it is currentCatId');
  });

  it('cross-thread: @gemini still works normally when currentCatId is undefined (no regression)', async () => {
    const { parseA2AMentions } = await import('../dist/domains/cats/services/agents/routing/a2a-mentions.js');
    const result = parseA2AMentions('@gemini 请确认这个安排', undefined);
    assert.ok(result.includes('gemini'), '@gemini should work with undefined currentCatId');
  });
});

describe('#417: detectInlineActionMentions', () => {
  it('detects inline @mention with action word (Ready for @codex review)', async () => {
    const { detectInlineActionMentions } = await import('../dist/domains/cats/services/agents/routing/a2a-mentions.js');
    const text = '217 tests pass. Ready for @codex review on lifecycle completeness.';
    const result = detectInlineActionMentions(text, 'opus', []);
    assert.equal(result.length, 1);
    assert.equal(result[0].catId, 'codex');
  });

  it('detects Chinese action word with inline @mention', async () => {
    const { detectInlineActionMentions } = await import('../dist/domains/cats/services/agents/routing/a2a-mentions.js');
    const text = '这个方案 @codex 请帮忙看一下';
    const result = detectInlineActionMentions(text, 'opus', []);
    assert.equal(result.length, 1);
    assert.equal(result[0].catId, 'codex');
  });

  it('ignores inline @mention WITHOUT action word (pure narrative)', async () => {
    const { detectInlineActionMentions } = await import('../dist/domains/cats/services/agents/routing/a2a-mentions.js');
    const text = '之前 @codex 提出的方案不错';
    const result = detectInlineActionMentions(text, 'opus', []);
    assert.deepEqual(result, []);
  });

  it('skips cats already routed via line-start mention', async () => {
    const { detectInlineActionMentions } = await import('../dist/domains/cats/services/agents/routing/a2a-mentions.js');
    const text = 'Ready for @codex review';
    const result = detectInlineActionMentions(text, 'opus', ['codex']);
    assert.deepEqual(result, []);
  });

  it('ignores line-start @mention (those are handled by parseA2AMentions)', async () => {
    const { detectInlineActionMentions } = await import('../dist/domains/cats/services/agents/routing/a2a-mentions.js');
    const text = '@codex 请 review';
    const result = detectInlineActionMentions(text, 'opus', []);
    assert.deepEqual(result, []);
  });

  it('ignores @mention inside code blocks', async () => {
    const { detectInlineActionMentions } = await import('../dist/domains/cats/services/agents/routing/a2a-mentions.js');
    const text = '看看代码：\n```\nReady for @codex review\n```';
    const result = detectInlineActionMentions(text, 'opus', []);
    assert.deepEqual(result, []);
  });

  it('ignores @mention inside blockquotes', async () => {
    const { detectInlineActionMentions } = await import('../dist/domains/cats/services/agents/routing/a2a-mentions.js');
    const text = '> Ready for @codex review';
    const result = detectInlineActionMentions(text, 'opus', []);
    assert.deepEqual(result, []);
  });

  it('filters self-mention', async () => {
    const { detectInlineActionMentions } = await import('../dist/domains/cats/services/agents/routing/a2a-mentions.js');
    const text = 'Ready for @opus review';
    const result = detectInlineActionMentions(text, 'opus', []);
    assert.deepEqual(result, []);
  });

  it('returns empty for empty text', async () => {
    const { detectInlineActionMentions } = await import('../dist/domains/cats/services/agents/routing/a2a-mentions.js');
    assert.deepEqual(detectInlineActionMentions('', 'opus', []), []);
  });

  // --- P1 regression: gpt52 review repro cases (proximity-based matching) ---

  it('P1-repro: "请按 @codex 之前的建议" is narrative, not handoff', async () => {
    const { detectInlineActionMentions } = await import('../dist/domains/cats/services/agents/routing/a2a-mentions.js');
    const text = '请按 @codex 之前的建议继续处理这个问题。';
    const result = detectInlineActionMentions(text, 'opus', []);
    assert.deepEqual(result, [], 'should not trigger: "请按" is not a handoff directive to @codex');
  });

  it('P1-repro: multi-mention line targets the right cat', async () => {
    const { detectInlineActionMentions } = await import('../dist/domains/cats/services/agents/routing/a2a-mentions.js');
    const text = '之前 @codex 讨论过，Ready for @gemini review on this patch.';
    const result = detectInlineActionMentions(text, 'opus', []);
    assert.equal(result.length, 1, 'should detect exactly one inline action mention');
    assert.equal(result[0].catId, 'gemini', 'should target gemini (Ready for), not codex (narrative)');
  });

  it('proximity: "帮 @codex review" triggers (adjacent action)', async () => {
    const { detectInlineActionMentions } = await import('../dist/domains/cats/services/agents/routing/a2a-mentions.js');
    const text = '这个问题帮 @codex review 一下';
    const result = detectInlineActionMentions(text, 'opus', []);
    assert.equal(result.length, 1);
    assert.equal(result[0].catId, 'codex');
  });

  it('proximity: distant action word does not trigger', async () => {
    const { detectInlineActionMentions } = await import('../dist/domains/cats/services/agents/routing/a2a-mentions.js');
    const text = '请参考 @codex 提出的方案并继续处理';
    const result = detectInlineActionMentions(text, 'opus', []);
    assert.deepEqual(result, [], 'action words "请" and "处理" are not adjacent to @codex');
  });

  // --- R2 P1 regression: completion suffixes turn commands into narrative ---

  it('R2-P1: "@codex 处理过" is narrative (completion suffix 过)', async () => {
    const { detectInlineActionMentions } = await import('../dist/domains/cats/services/agents/routing/a2a-mentions.js');
    assert.deepEqual(detectInlineActionMentions('之前 @codex 处理过这个问题', 'opus', []), []);
  });

  it('R2-P1: "@codex 确认了" is narrative (completion suffix 了)', async () => {
    const { detectInlineActionMentions } = await import('../dist/domains/cats/services/agents/routing/a2a-mentions.js');
    assert.deepEqual(detectInlineActionMentions('之前 @codex 确认了这个方案', 'opus', []), []);
  });

  it('R2-P1: "@codex 来看过" is narrative (completion suffix 过)', async () => {
    const { detectInlineActionMentions } = await import('../dist/domains/cats/services/agents/routing/a2a-mentions.js');
    assert.deepEqual(detectInlineActionMentions('之前 @codex 来看过一次', 'opus', []), []);
  });

  it('R2-P1: "@codex 处理一下" is still handoff (no completion suffix)', async () => {
    const { detectInlineActionMentions } = await import('../dist/domains/cats/services/agents/routing/a2a-mentions.js');
    const result = detectInlineActionMentions('这个问题 @codex 处理一下', 'opus', []);
    assert.equal(result.length, 1);
    assert.equal(result[0].catId, 'codex');
  });

  // --- R2 P2 regression: same cat appears twice, second occurrence is handoff ---

  it('R2-P2: same cat twice — first narrative, second handoff', async () => {
    const { detectInlineActionMentions } = await import('../dist/domains/cats/services/agents/routing/a2a-mentions.js');
    const text = '之前 @codex 提过意见，现在 Ready for @codex review';
    const result = detectInlineActionMentions(text, 'opus', []);
    assert.equal(result.length, 1, 'should detect the second occurrence as handoff');
    assert.equal(result[0].catId, 'codex');
  });

  // --- Codex review: routed cat on same line must not block other cats ---

  it('routed cat does not block other cats on same line', async () => {
    const { detectInlineActionMentions } = await import('../dist/domains/cats/services/agents/routing/a2a-mentions.js');
    const text = 'Ready for @codex and @gemini review';
    // codex already routed via line-start, gemini is not
    const result = detectInlineActionMentions(text, 'opus', ['codex']);
    assert.equal(result.length, 1, 'should still detect gemini');
    assert.equal(result[0].catId, 'gemini');
  });

  // --- Codex R3: 请 compound exclusion + left boundary ---

  it('"@codex 请教过" is narrative (请教 = consult, not imperative)', async () => {
    const { detectInlineActionMentions } = await import('../dist/domains/cats/services/agents/routing/a2a-mentions.js');
    assert.deepEqual(detectInlineActionMentions('之前 @codex 请教过这个问题', 'opus', []), []);
  });

  it('"@codex 请看" is still handoff (请 + action verb)', async () => {
    const { detectInlineActionMentions } = await import('../dist/domains/cats/services/agents/routing/a2a-mentions.js');
    const result = detectInlineActionMentions('这个 @codex 请看一下', 'opus', []);
    assert.equal(result.length, 1);
  });

  it('ignores embedded @mention without left boundary (foo@codex)', async () => {
    const { detectInlineActionMentions } = await import('../dist/domains/cats/services/agents/routing/a2a-mentions.js');
    assert.deepEqual(detectInlineActionMentions('contact foo@codex review', 'opus', []), []);
  });

  it('detects @mention with left boundary (space before @)', async () => {
    const { detectInlineActionMentions } = await import('../dist/domains/cats/services/agents/routing/a2a-mentions.js');
    const result = detectInlineActionMentions('contact @codex review', 'opus', []);
    assert.equal(result.length, 1);
  });

  // --- Codex R4: English verb boundary ---

  it('"@codex reviewed" is narrative (past tense, not imperative)', async () => {
    const { detectInlineActionMentions } = await import('../dist/domains/cats/services/agents/routing/a2a-mentions.js');
    assert.deepEqual(detectInlineActionMentions('之前 @codex reviewed this', 'opus', []), []);
  });

  it('"@codex checklist" is narrative (compound word)', async () => {
    const { detectInlineActionMentions } = await import('../dist/domains/cats/services/agents/routing/a2a-mentions.js');
    assert.deepEqual(detectInlineActionMentions('@codex checklist 已更新', 'opus', []), []);
  });

  // --- Codex R5: 请 as compound suffix (邀请/申请) ---

  it('"邀请 @codex 参加评审" is narrative (邀请 = invite, not imperative 请)', async () => {
    const { detectInlineActionMentions } = await import('../dist/domains/cats/services/agents/routing/a2a-mentions.js');
    assert.deepEqual(detectInlineActionMentions('邀请 @codex 参加评审', 'opus', []), []);
  });

  it('"申请 @codex 权限" is narrative (申请 = apply, not imperative 请)', async () => {
    const { detectInlineActionMentions } = await import('../dist/domains/cats/services/agents/routing/a2a-mentions.js');
    assert.deepEqual(detectInlineActionMentions('申请 @codex 权限', 'opus', []), []);
  });

  it('"请 @codex review" still triggers (standalone 请 is imperative)', async () => {
    const { detectInlineActionMentions } = await import('../dist/domains/cats/services/agents/routing/a2a-mentions.js');
    const result = detectInlineActionMentions('这个问题请 @codex review 一下', 'opus', []);
    assert.equal(result.length, 1);
  });

  // --- Codex R6: already-seen cat must not block fresh cats on later lines ---

  it('already-seen cat (longer pattern, scanned first) does not block fresh cat on same line', async () => {
    const { detectInlineActionMentions } = await import('../dist/domains/cats/services/agents/routing/a2a-mentions.js');
    // @gemini (7 chars) is longer than @codex (6 chars), so entries sort puts gemini first.
    // Line 1 adds gemini to seen. Line 2: gemini scanned first → already seen → must NOT set lineMatched.
    const text = 'Ready for @gemini review\nReady for @gemini and @codex review';
    const result = detectInlineActionMentions(text, 'opus', []);
    const catIds = result.map((r) => r.catId);
    assert.ok(catIds.includes('gemini'), 'gemini should be detected from line 1');
    assert.ok(catIds.includes('codex'), 'codex should be detected from line 2 even though gemini already seen');
  });
});

describe('SystemPromptBuilder A2A injection', () => {
  it('includes A2A section when a2aEnabled and serial mode', async () => {
    const { buildSystemPrompt } = await import('../dist/domains/cats/services/context/SystemPromptBuilder.js');
    const prompt = buildSystemPrompt({
      catId: 'opus',
      mode: 'serial',
      teammates: ['codex', 'gemini'],
      mcpAvailable: false,
      a2aEnabled: true,
    });
    assert.ok(prompt.includes('协作'), 'should include 协作 section');
    assert.ok(prompt.includes('@队友'), 'should include @队友 instruction');
  });

  it('parallel mode uses independent thinking context (collaboration guide still present)', async () => {
    const { buildSystemPrompt } = await import('../dist/domains/cats/services/context/SystemPromptBuilder.js');
    const prompt = buildSystemPrompt({
      catId: 'opus',
      mode: 'parallel',
      teammates: ['codex', 'gemini'],
      mcpAvailable: false,
      a2aEnabled: true,
    });
    // Static collaboration guide is always present (cats should always know how to @)
    assert.ok(prompt.includes('## 协作'), 'should include static collaboration guide');
    // Parallel mode should indicate independent thinking
    assert.ok(prompt.includes('独立思考'), 'should indicate independent thinking in parallel mode');
  });

  it('includes A2A section even with empty teammates (single-cat scenario)', async () => {
    const { buildSystemPrompt } = await import('../dist/domains/cats/services/context/SystemPromptBuilder.js');
    // Single-cat: only opus in worklist, teammates = []
    const prompt = buildSystemPrompt({
      catId: 'opus',
      mode: 'independent',
      teammates: [],
      mcpAvailable: false,
      a2aEnabled: true,
    });
    assert.ok(prompt.includes('协作'), 'should include 协作 even with empty teammates');
    assert.ok(prompt.includes('@缅因猫'), 'should list codex as callable');
    assert.ok(prompt.includes('@暹罗猫'), 'should list gemini as callable');
    assert.ok(!prompt.includes('@布偶猫'), 'should NOT list self as callable');
  });
});
