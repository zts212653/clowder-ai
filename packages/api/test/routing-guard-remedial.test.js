/**
 * F177 Phase H — server-side routing guard remedial 判据（路径 B）.
 *
 * 只测纯判据函数；实际 inline remedial invoke 走 route-serial 集成路径。
 * 原则（KD-8 safe）：只看"有无机械出口信号"，零意图分类器。
 */

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
  buildRemedialPrompt,
  hasValidRoutingExit,
  shouldRemediateRouting,
} from '../dist/domains/cats/services/agents/routing/guards/routing-guard-remedial.js';

const base = {
  lineStartMentions: [],
  toolNames: [],
  structuredTargetCats: [],
  hasCoCreatorLineStartMention: false,
};

describe('F177 Phase H — shouldRemediateRouting', () => {
  test('codex 无任何出口 + needsGuard + 未补救 → 触发 remedial', () => {
    assert.equal(shouldRemediateRouting({ ...base, needsGuard: true, attempted: false }), true);
  });

  test('非 guard 猫（Claude 系，已有 Stop hook）无出口 → 不触发', () => {
    assert.equal(shouldRemediateRouting({ ...base, needsGuard: false, attempted: false }), false);
  });

  test('one-shot guard：已补救过 → 不再触发（防 codex 烧猫粮）', () => {
    assert.equal(shouldRemediateRouting({ ...base, needsGuard: true, attempted: true }), false);
  });

  test('有行首 @ 传球 → 不触发', () => {
    assert.equal(
      shouldRemediateRouting({ ...base, lineStartMentions: ['opus48'], needsGuard: true, attempted: false }),
      false,
    );
  });

  test('有 hold_ball 工具 → 不触发', () => {
    assert.equal(
      shouldRemediateRouting({ ...base, toolNames: ['cat_cafe_hold_ball'], needsGuard: true, attempted: false }),
      false,
    );
  });

  test('有 multi_mention 工具 → 不触发', () => {
    assert.equal(
      shouldRemediateRouting({ ...base, toolNames: ['cat_cafe_multi_mention'], needsGuard: true, attempted: false }),
      false,
    );
  });

  test('有 structuredTargetCats（cross_post）→ 不触发', () => {
    assert.equal(
      shouldRemediateRouting({ ...base, structuredTargetCats: ['opus48'], needsGuard: true, attempted: false }),
      false,
    );
  });

  test('有 co-creator @co-creator 升级 → 不触发', () => {
    assert.equal(
      shouldRemediateRouting({ ...base, hasCoCreatorLineStartMention: true, needsGuard: true, attempted: false }),
      false,
    );
  });

  test('fake-hold（说持球但无 hold_ball 工具、无其他出口）→ 触发 [gpt52 主 failure]', () => {
    // 判据只看"有无出口"，不看"持球"文本。说了持球却没调 hold_ball = 无出口 = 该补救。
    assert.equal(
      shouldRemediateRouting({ ...base, toolNames: ['cat_cafe_search_evidence'], needsGuard: true, attempted: false }),
      true,
    );
  });
});

describe('F177 Phase H — hasValidRoutingExit', () => {
  test('无任何信号 → false', () => {
    assert.equal(hasValidRoutingExit(base), false);
  });
  test('行首 @ / hold_ball / multi_mention / targetCats / co-creator 任一 → true', () => {
    assert.equal(hasValidRoutingExit({ ...base, lineStartMentions: ['x'] }), true);
    assert.equal(hasValidRoutingExit({ ...base, toolNames: ['mcp__cat-cafe__cat_cafe_hold_ball'] }), true);
    assert.equal(hasValidRoutingExit({ ...base, toolNames: ['cat_cafe_multi_mention'] }), true);
    assert.equal(hasValidRoutingExit({ ...base, structuredTargetCats: ['x'] }), true);
    assert.equal(hasValidRoutingExit({ ...base, hasCoCreatorLineStartMention: true }), true);
  });
});

describe('F177 Phase H — buildRemedialPrompt', () => {
  test('含路由指引（行首 @ / hold_ball / @co-creator）且明确不重做工作', () => {
    const p = buildRemedialPrompt();
    assert.match(p, /行首/);
    assert.match(p, /hold_ball/);
    assert.match(p, /@co-creator/);
    assert.match(p, /不要重做/);
  });
});
