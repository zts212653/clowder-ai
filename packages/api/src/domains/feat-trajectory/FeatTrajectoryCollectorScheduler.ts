/**
 * F233 Phase C C2b step 4 — Feat Trajectory Collector Scheduler
 *
 * 周期触发 `GitRefSnapshotCollector.collectAll` → `FeatTrajectoryProjector
 * .applyGitRefSnapshot` → `IFeatTrajectoryStore.save`. 照 BallCustodyProbeScheduler
 * pattern: scheduler 是纯函数 tick(), TaskSpec wrapper 给 taskRunnerV2 注册.
 *
 * Idempotent: 同 snapshot 二次 tick → upsert by stable entryId (cloud P2 fix)
 * → 不会 inflate counts.
 *
 * plan: docs/plans/2026-06-18-f233-phase-c-euthanasia-trajectory.md §C2b
 */

import type { FeatTrajectoryProjector } from './FeatTrajectoryProjector.js';
import type { IFeatTrajectoryStore } from './FeatTrajectoryStore.js';
import type { GitRefSnapshotCollector } from './GitRefSnapshotCollector.js';

export interface FeatTrajectoryCollectorSchedulerOptions {
  readonly collector: GitRefSnapshotCollector;
  readonly projector: FeatTrajectoryProjector;
  readonly store: IFeatTrajectoryStore;
  readonly now?: () => number;
  readonly logger?: {
    warn?: (obj: unknown, msg?: string) => void;
    info?: (obj: unknown, msg?: string) => void;
    error?: (obj: unknown, msg?: string) => void;
  };
}

export interface FeatTrajectoryCollectorTickResult {
  /** Number of snapshots produced by collector.collectAll(). */
  collected: number;
  /** Number of snapshots successfully applied to projector. */
  applied: number;
  /** Number of snapshots that errored during apply (skipped, not fatal). */
  failed: number;
  /** Total feats now in store after this tick. */
  featsInStore: number;
}

export class FeatTrajectoryCollectorScheduler {
  private readonly now: () => number;

  constructor(private readonly opts: FeatTrajectoryCollectorSchedulerOptions) {
    this.now = opts.now ?? Date.now;
  }

  async tick(): Promise<FeatTrajectoryCollectorTickResult> {
    const result: FeatTrajectoryCollectorTickResult = {
      collected: 0,
      applied: 0,
      failed: 0,
      featsInStore: 0,
    };

    const tickStart = this.now();
    let snapshots: Awaited<ReturnType<GitRefSnapshotCollector['collectAll']>>;
    try {
      snapshots = await this.opts.collector.collectAll(tickStart);
    } catch (e) {
      this.opts.logger?.error?.({ err: errMsg(e) }, '[feat-trajectory] collector.collectAll failed');
      return result;
    }
    result.collected = snapshots.length;

    for (const snap of snapshots) {
      try {
        await this.opts.projector.applyGitRefSnapshot(snap);
        result.applied += 1;
      } catch (e) {
        result.failed += 1;
        this.opts.logger?.warn?.(
          { branchName: snap.branchName, err: errMsg(e) },
          '[feat-trajectory] applyGitRefSnapshot failed; skip snapshot',
        );
      }
    }

    try {
      const feats = await this.opts.store.listFeatIds();
      result.featsInStore = feats.length;
    } catch (e) {
      this.opts.logger?.warn?.({ err: errMsg(e) }, '[feat-trajectory] listFeatIds for stats failed');
    }

    // Cloud round 2 P2 fix: record collector observation time so UI freshness
    // reflects "when did the collector last run", not max event time. Even when
    // 0 snapshots are produced (e.g., quiet period, no new pushes), the tick
    // itself ran — the UI should show this as "fresh".
    try {
      await this.opts.store.setLastCollectorTickAt(tickStart);
    } catch (e) {
      this.opts.logger?.warn?.({ err: errMsg(e) }, '[feat-trajectory] setLastCollectorTickAt failed');
    }

    if (result.applied > 0 || result.failed > 0) {
      this.opts.logger?.info?.(
        { result, tickStart },
        `[feat-trajectory] tick: ${result.applied}/${result.collected} applied, ${result.featsInStore} feats in store`,
      );
    }

    return result;
  }
}

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
