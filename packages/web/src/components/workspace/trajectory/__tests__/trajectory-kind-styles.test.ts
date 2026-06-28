/**
 * F233 Phase C C3 — trajectory-kind-styles 纯逻辑 test。
 * 核心：提包球判定边界 + 13 kind 视觉映射完整性。
 */

import type { FeatTrajectoryKind } from '@cat-cafe/shared';
import { describe, expect, it } from 'vitest';
import { isCarryingBag, KIND_VISUALS, SOURCE_LABELS, TONE_CLASSES } from '../trajectory-kind-styles';

describe('isCarryingBag — 提包球判定（branch_stale_unmerged + 猫提包离线）', () => {
  it('stale + lastThreadMessageAt < headCommitAt → true（猫推完代码走了没回头）', () => {
    expect(isCarryingBag('branch_stale_unmerged', 1000, 2000)).toBe(true);
  });

  it('lastThreadMessageAt >= headCommitAt → false（push 后 thread 还有活动，没"提包走")', () => {
    expect(isCarryingBag('branch_stale_unmerged', 2000, 2000)).toBe(false);
    expect(isCarryingBag('branch_stale_unmerged', 3000, 2000)).toBe(false);
  });

  it('lastThreadMessageAt = null → false（join 失败/无 thread，证不了提包）', () => {
    expect(isCarryingBag('branch_stale_unmerged', null, 2000)).toBe(false);
  });

  it('非 branch_stale_unmerged → false（即使时间满足也不是提包球）', () => {
    expect(isCarryingBag('branch_pushed', 1000, 2000)).toBe(false);
    expect(isCarryingBag('pr_merged', 1000, 2000)).toBe(false);
    expect(isCarryingBag('historical_stitched', 1000, 2000)).toBe(false);
  });
});

describe('KIND_VISUALS — 13 kind 视觉映射完整性', () => {
  const ALL_KINDS: FeatTrajectoryKind[] = [
    'launched',
    'phase_transition',
    'pr_merged',
    'verdict',
    'thread_split',
    'thread_merge',
    'closed',
    'reopened',
    'branch_pushed',
    'pr_opened',
    'branch_merged_to_main',
    'branch_stale_unmerged',
    'historical_stitched',
  ];

  it('全部 13 kind 都有 visual 映射，且 tone 在 TONE_CLASSES 中存在', () => {
    expect(ALL_KINDS).toHaveLength(13);
    for (const k of ALL_KINDS) {
      const v = KIND_VISUALS[k];
      expect(v, `kind ${k} 缺 visual 映射`).toBeDefined();
      expect(v.label.length, `kind ${k} label 为空`).toBeGreaterThan(0);
      expect(TONE_CLASSES[v.tone], `tone ${v.tone} 缺 class`).toBeDefined();
    }
  });

  it('配色 family 锚点（设计稿 §1）：提包球=amber，历史考古=gray，launched=purple', () => {
    expect(KIND_VISUALS.branch_stale_unmerged.tone).toBe('amber');
    expect(KIND_VISUALS.historical_stitched.tone).toBe('gray');
    expect(KIND_VISUALS.launched.tone).toBe('purple');
    expect(KIND_VISUALS.pr_merged.tone).toBe('emerald');
    expect(KIND_VISUALS.branch_pushed.tone).toBe('cyan');
  });

  it('family 分类正确（ball / git / historical）', () => {
    expect(KIND_VISUALS.launched.family).toBe('ball');
    expect(KIND_VISUALS.branch_stale_unmerged.family).toBe('git');
    expect(KIND_VISUALS.historical_stitched.family).toBe('historical');
  });
});

describe('SOURCE_LABELS — 三源标签', () => {
  it('三源都有友好标签', () => {
    expect(SOURCE_LABELS['event-stream']).toBe('event-stream');
    expect(SOURCE_LABELS['git-ref-snapshot']).toBe('git-ref');
    expect(SOURCE_LABELS['historical-stitched']).toBe('stitched');
  });
});

describe('TONE_CLASSES — purge-safe 静态 class 完整性', () => {
  it('每个 tone 有 dot/badge/cardBorder/line 四组 class（非空字面量）', () => {
    for (const tone of ['purple', 'emerald', 'cyan', 'amber', 'gray'] as const) {
      const c = TONE_CLASSES[tone];
      expect(c.dot.length, `${tone}.dot 空`).toBeGreaterThan(0);
      expect(c.badge.length, `${tone}.badge 空`).toBeGreaterThan(0);
      expect(c.cardBorder.length, `${tone}.cardBorder 空`).toBeGreaterThan(0);
      expect(c.line.length, `${tone}.line 空`).toBeGreaterThan(0);
    }
  });
});
