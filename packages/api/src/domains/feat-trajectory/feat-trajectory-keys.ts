/**
 * F233 Phase C C2a — Feat Trajectory key derivation helpers.
 *
 * KD-1（不引球 ID 新原语）：subjectKey 派生自现有痕迹，re-export shared
 * `makeGitRefEntryId` pure formula 供 collector / projector / tests 用。
 *
 * plan: docs/plans/2026-06-18-f233-phase-c-euthanasia-trajectory.md §C
 */

import {
  type FeatTrajectorySource,
  type GitRefEntryIdParts,
  makeGitRefEntryId,
  type StaleBucket,
} from '@cat-cafe/shared';

/** Re-export shared pure formula for convenience in api scope (collector / projector / tests). */
export { makeGitRefEntryId };
export type { GitRefEntryIdParts };

// ============================================================================
// Stale bucket thresholds + assignment (砚砚 step 4 护栏支持)
// ============================================================================

/**
 * Stale bucket → 阈值 ms 映射。砚砚 step 4 护栏：projector 用此算
 * `branch_stale_unmerged.entry.at = headCommitAt + bucketThresholdMs`（首次跨阈值
 * 时刻；不用 `collectedAt` 伪装真实事件时间）。Collector 用此分配 first-crossed
 * bucket。
 */
export const STALE_BUCKET_THRESHOLDS_MS: Record<StaleBucket, number> = {
  '24h': 24 * 60 * 60 * 1000,
  '72h': 72 * 60 * 60 * 1000,
  '7d': 7 * 24 * 60 * 60 * 1000,
  '30d': 30 * 24 * 60 * 60 * 1000,
};

/**
 * 按 ageMs 分配 stale bucket（**largest crossed**）。
 *
 * 关键决策：返回 largest crossed bucket（如 age=10d → 返 '7d'，不是 '24h'）。
 * 理由：单次 tick 在 collectedAt=day10 时只表征 "branch 已 stale 7d+" 当前事实，
 * 不模拟历史"曾经 24h 时跨过 24h 阈值"——历史 24h/72h entries 由 cron tick 在
 * day 1 / day 3 时各自 emit（轨迹 entries 累加）。
 *
 * age 不足 24h 返回 null（不 emit `branch_stale_unmerged`）。
 */
export function staleBucketForAge(ageMs: number): StaleBucket | null {
  // Check largest first
  const buckets: StaleBucket[] = ['30d', '7d', '72h', '24h'];
  for (const b of buckets) {
    if (ageMs >= STALE_BUCKET_THRESHOLDS_MS[b]) return b;
  }
  return null;
}

/** `feat:{featId}` — feat 维度 trajectory projection key（rebuild-safe）。 */
export function makeFeatSubjectKey(featId: string): string {
  return `feat:${featId}`;
}

/** `git-ref:{branchName}` — git ref 维度 subjectKey（用于 git-ref-snapshot kind 的 entry.subjectKey）。 */
export function makeGitRefSubjectKey(branchName: string): string {
  return `git-ref:${branchName}`;
}

/**
 * Entry id 派生（per source）：
 * - event-stream: `evt:{ballCustodyEvent.sourceEventId}`（trace-back AC-C3，trajectory 单账本验证用）
 * - historical-stitched: `stitch:{featId}:{at}:{stitchType}`（一次性脚本产物）
 * - git-ref-snapshot: makeGitRefEntryId(parts) 公式（砚砚 P2-2 + P2-4）
 */
export function makeEventStreamEntryId(ballCustodySourceEventId: string): string {
  return `evt:${ballCustodySourceEventId}`;
}

export function makeStitchedEntryId(featId: string, at: number, stitchType: string): string {
  return `stitch:${featId}:${at}:${stitchType}`;
}

/**
 * Redis key namespace (照 Phase B BallCustodyKeys 模式)。
 * 同一 cell `feat-trajectory` 下 projection + entries store 分桶。
 */
export const FeatTrajectoryKeys = {
  /** Per-feat projection blob: feat-trajectory:projection:{featId} */
  projection(featId: string): string {
    return `feat-trajectory:projection:${featId}`;
  },
  /** Per-source counter / observability: feat-trajectory:counts:{source} */
  countsBySource(source: FeatTrajectorySource): string {
    return `feat-trajectory:counts:${source}`;
  },
  /** All known feat ids set (for listFeatIds / rebuild): feat-trajectory:feats */
  feats(): string {
    return 'feat-trajectory:feats';
  },
  /** Last collector tick observation time (Unix ms): feat-trajectory:last-collector-tick-at */
  lastCollectorTickAt(): string {
    return 'feat-trajectory:last-collector-tick-at';
  },
};
