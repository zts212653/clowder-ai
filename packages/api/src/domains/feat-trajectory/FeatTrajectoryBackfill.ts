/**
 * F233 Phase C C2c — Historical backfill logic（一次性脚本入口 + 可测函数）
 *
 * 用 4 个 real IO adapter（GitRunner / GhClient / FeatIndexLookup / ThreadSearch）
 * 跑 collector.collectAll → projector.applyGitRefSnapshot → store.save 全 feats。
 *
 * 设计：核心逻辑提到 `runBackfill(deps)` 纯函数，scripts/ 下的 entry script 拼好
 * deps 后调它。test 用 stub deps 验证 main flow（不依赖真 Redis / git）。
 *
 * plan: docs/plans/2026-06-18-f233-phase-c-euthanasia-trajectory.md §C2c
 */

import type { FeatTrajectoryProjection } from '@cat-cafe/shared';
import type { FeatTrajectoryProjector } from './FeatTrajectoryProjector.js';
import type { IFeatTrajectoryStore } from './FeatTrajectoryStore.js';
import type { GitRefSnapshotCollector } from './GitRefSnapshotCollector.js';

export interface FeatTrajectoryBackfillDeps {
  collector: GitRefSnapshotCollector;
  projector: FeatTrajectoryProjector;
  store: IFeatTrajectoryStore;
  /** Unix ms — cron tick "now" for staleBucket assignment. Default Date.now(). */
  now?: () => number;
  /** Logger (production = console; tests = stub array push). */
  logger?: (msg: string) => void;
}

export interface FeatTrajectoryBackfillResult {
  snapshotsCollected: number;
  snapshotsApplied: number;
  featsInStore: string[];
  /** Per-feat summary: entries count + counts by kind. */
  perFeatSummary: Array<{
    featId: string;
    entryCount: number;
    countsByKind: Record<string, number>;
  }>;
}

/**
 * Run historical backfill. Returns summary; does not exit.
 *
 * Caller (script entry) responsible for:
 * - Building deps (Redis connection, RealGitRunner, RealGhClient, etc.)
 * - Cleanup (close Redis, etc.)
 * - Exit code based on result (non-zero on 0 snapshots = likely misconfig)
 */
export async function runBackfill(deps: FeatTrajectoryBackfillDeps): Promise<FeatTrajectoryBackfillResult> {
  const { collector, projector, store, now = Date.now, logger = () => {} } = deps;
  const tick = now();

  logger(`[F233 C2c] Collecting snapshots at tick=${new Date(tick).toISOString()}`);
  const snapshots = await collector.collectAll(tick);
  logger(`[F233 C2c]   → ${snapshots.length} snapshots collected`);

  logger(`[F233 C2c] Applying snapshots to projector...`);
  let applied = 0;
  for (const snap of snapshots) {
    try {
      await projector.applyGitRefSnapshot(snap);
      applied++;
    } catch (e) {
      const errMsg = e instanceof Error ? e.message : String(e);
      logger(`[F233 C2c]   ⚠️  skip snapshot for ${snap.branchName}: ${errMsg}`);
    }
  }
  logger(`[F233 C2c]   → ${applied}/${snapshots.length} snapshots applied`);

  const featsInStore = await store.listFeatIds();
  featsInStore.sort((a, b) => Number(a.replace(/^F/, '')) - Number(b.replace(/^F/, '')));

  const perFeatSummary: FeatTrajectoryBackfillResult['perFeatSummary'] = [];
  for (const featId of featsInStore) {
    const proj: FeatTrajectoryProjection | null = await store.get(featId);
    if (!proj) continue;
    perFeatSummary.push({
      featId,
      entryCount: proj.entries.length,
      countsByKind: { ...proj.countsByKind },
    });
  }

  logger(`[F233 C2c] Result: ${featsInStore.length} feats with projections`);
  for (const summary of perFeatSummary) {
    const kindsStr = Object.entries(summary.countsByKind)
      .map(([k, v]) => `${k}:${v}`)
      .join(' ');
    logger(`[F233 C2c]   ${summary.featId}: ${summary.entryCount} entries (${kindsStr})`);
  }

  return {
    snapshotsCollected: snapshots.length,
    snapshotsApplied: applied,
    featsInStore,
    perFeatSummary,
  };
}
