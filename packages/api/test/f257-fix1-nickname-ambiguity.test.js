/**
 * F257 修复清单 #1 — 路由歧义判定的 nickname 维度（sol review F2/F5 修复）。
 *
 * 失败模式（sol 活体复现）：砚砚是 5 只猫的 nickname，但 @砚砚 pattern 只在
 * codex 的 mentionPatterns 里 → pattern 视图唯一归属 → 零 warning 路由 codex。
 * 意图模型上 @昵称 就是「叫那只昵称为 X 的猫」——nickname 多持有即歧义。
 *
 * 契约（token → holders 统一视图，三源合并）：
 *   holders(@token) = pattern 持有者 ∪ nickname 持有者 ∪ canonical @catId
 *   - 多 holder → ambiguous（拒绝路由，即使 pattern 侧唯一归属）
 *   - 唯一 nickname 持有者且无 pattern 争夺 → @昵称 可路由（身份即 handle）
 *   - canonical @catId 是保留命名空间：每猫永远有一个可被同一 parser 识别的
 *     唯一显式 handle；candidates 推荐的 mention 必须回喂 parser 可 resolved
 */

import './helpers/setup-cat-registry.js';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { catRegistry, createCatId } from '@cat-cafe/shared';

const { analyzeA2AMentions } = await import('../dist/domains/cats/services/agents/routing/a2a-mentions.js');
const { resolveCatTarget } = await import('../dist/domains/cats/services/agents/routing/cat-target-resolver.js');

function mkConfig(catId, patterns, nickname) {
  return {
    id: createCatId(catId),
    name: `${catId}-name`,
    displayName: `${catId}-display`,
    ...(nickname ? { nickname } : {}),
    avatar: `/avatars/${catId}.png`,
    color: { primary: '#000000', secondary: '#ffffff' },
    mentionPatterns: patterns,
    clientId: 'anthropic',
    defaultModel: 'claude-sonnet-4-5-20250929',
    mcpSupport: true,
  };
}

// 活体 catalog 形状（sol F2 fixture 要求）：多猫共用 nickname、仅一猫显式持有 @nickname pattern
function registerLiveShapeCats() {
  const cats = [
    ['liv-a', ['@liv-a', '@砚测'], '砚测'], // codex 形状：pattern + nickname 双持
    ['liv-b', ['@liv-b'], '砚测'], // sol 形状：仅 nickname
    ['liv-c', ['@liv-c'], '砚测'], // spark 形状：仅 nickname
    ['liv-d', ['@liv-d'], '独测'], // 唯一 nickname 持有者（@独测 不在 patterns）
    ['liv-e', ['@共测2'], null], // 无唯一 pattern（共享 @共测2）——candidates 必须回退 canonical
    ['liv-f', ['@共测2'], null],
  ];
  for (const [catId, patterns, nickname] of cats) {
    if (!catRegistry.has(catId)) {
      catRegistry.register(catId, mkConfig(catId, patterns, nickname));
    }
  }
}

registerLiveShapeCats();

describe('F257 #1 修复（sol F2）：nickname 多持有 = 路由歧义，即使 pattern 唯一归属', () => {
  it('活体形状：@砚测（pattern 仅 liv-a 持有，nickname 三猫持有）→ 拒绝路由 + 三候选', () => {
    const analysis = analyzeA2AMentions('@砚测 请 review 这段代码', 'opus');
    assert.deepEqual(analysis.mentions, [], 'nickname collision must NOT route to the sole pattern holder');
    const ambiguous = analysis.routing_warnings.filter((w) => w.kind === 'mention_ambiguous');
    assert.equal(ambiguous.length, 1);
    assert.deepEqual(
      ambiguous[0].candidates.map((c) => String(c.catId)).sort(),
      ['liv-a', 'liv-b', 'liv-c'],
      'candidates must include ALL nickname holders, not just pattern holders',
    );
  });

  it('resolveCatTarget(@砚测) → mention_ambiguous（显式 target 入口同一视图）', () => {
    const resolved = resolveCatTarget('@砚测');
    assert.ok('error' in resolved, 'nickname collision must be an error');
    assert.equal(resolved.error.kind, 'mention_ambiguous');
    assert.deepEqual(resolved.error.candidates.map((c) => String(c.catId)).sort(), ['liv-a', 'liv-b', 'liv-c']);
  });

  it('唯一 nickname 持有者：@独测（不在 patterns）→ 正常路由到 liv-d（身份即 handle）', () => {
    const analysis = analyzeA2AMentions('@独测 接球', 'opus');
    assert.deepEqual(analysis.mentions.map(String), ['liv-d']);
    assert.equal(analysis.routing_warnings.length, 0);
  });

  it('显式唯一 pattern 不受同猫 nickname 影响：@liv-a 照常路由（回归保护）', () => {
    const analysis = analyzeA2AMentions('@liv-a 接球', 'opus');
    assert.deepEqual(analysis.mentions.map(String), ['liv-a']);
    assert.equal(analysis.routing_warnings.length, 0);
  });
});

describe('F257 #1 修复（sol F5）：candidates 推荐 handle 必须可被同一 parser 路由', () => {
  it('无唯一 pattern 的猫（共享 @共测2）→ candidates 回退 canonical @catId', () => {
    const analysis = analyzeA2AMentions('@共测2 一起看', 'opus');
    assert.deepEqual(analysis.mentions, []);
    const ambiguous = analysis.routing_warnings.filter((w) => w.kind === 'mention_ambiguous');
    assert.equal(ambiguous.length, 1);
    const mentionByCat = new Map(ambiguous[0].candidates.map((c) => [String(c.catId), c.mention]));
    assert.equal(mentionByCat.get('liv-e'), '@liv-e', 'canonical @catId must be the fallback handle');
    assert.equal(mentionByCat.get('liv-f'), '@liv-f');
  });

  it('推荐的每个 candidate.mention 回喂 A2A parser 都能 resolved 到对应猫', () => {
    const analysis = analyzeA2AMentions('@共测2 一起看', 'opus');
    const ambiguous = analysis.routing_warnings.filter((w) => w.kind === 'mention_ambiguous');
    for (const candidate of ambiguous[0].candidates) {
      const retry = analyzeA2AMentions(`${candidate.mention} 重试`, 'opus');
      assert.deepEqual(
        retry.mentions.map(String),
        [String(candidate.catId)],
        `recommended handle ${candidate.mention} must actually route to ${candidate.catId}`,
      );
    }
  });

  it('canonical @catId 直接可路由（保留命名空间，无需出现在 mentionPatterns）', () => {
    // liv-e 的 patterns 只有共享的 @共测2 —— @liv-e 是合成 canonical
    const analysis = analyzeA2AMentions('@liv-e 接球', 'opus');
    assert.deepEqual(analysis.mentions.map(String), ['liv-e']);
    assert.equal(analysis.routing_warnings.length, 0);
  });
});
