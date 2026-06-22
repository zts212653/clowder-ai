/**
 * F233 Phase C C2b step 4 — Cron TaskSpec wrapping FeatTrajectoryCollectorScheduler
 *
 * 照 BallCustodyProbeTaskSpec pattern. 注册到 taskRunnerV2 → 周期跑 scheduler.tick().
 * Interval 由 env F233_FEAT_TRAJECTORY_COLLECTOR_INTERVAL_MS 控制 (默认 15 min).
 *
 * plan: docs/plans/2026-06-18-f233-phase-c-euthanasia-trajectory.md §C2b
 */

import type { TaskSpec_P1 } from '../../infrastructure/scheduler/types.js';
import type { FeatTrajectoryCollectorScheduler } from './FeatTrajectoryCollectorScheduler.js';

export const FEAT_TRAJECTORY_COLLECTOR_TASK_ID = 'f233-feat-trajectory-collector';
export const DEFAULT_FEAT_TRAJECTORY_COLLECTOR_INTERVAL_MS = 15 * 60 * 1000; // 15 min
export const FEAT_TRAJECTORY_COLLECTOR_RUN_TIMEOUT_MS = 120_000;

export interface FeatTrajectoryCollectorTaskSpecOptions {
  readonly scheduler: FeatTrajectoryCollectorScheduler;
  readonly intervalMs?: number;
  readonly log?: {
    info?: (obj: unknown, msg?: string) => void;
    warn?: (obj: unknown, msg?: string) => void;
  };
}

export function createFeatTrajectoryCollectorTaskSpec(opts: FeatTrajectoryCollectorTaskSpecOptions): TaskSpec_P1 {
  return {
    id: FEAT_TRAJECTORY_COLLECTOR_TASK_ID,
    profile: 'poller',
    trigger: {
      type: 'interval',
      ms: opts.intervalMs ?? DEFAULT_FEAT_TRAJECTORY_COLLECTOR_INTERVAL_MS,
    },
    admission: {
      async gate() {
        return {
          run: true,
          workItems: [{ signal: null, subjectKey: 'feat-trajectory-collector' }],
        };
      },
    },
    run: {
      overlap: 'skip', // 同一时刻只一个 tick, 防 collector 互相覆盖
      timeoutMs: FEAT_TRAJECTORY_COLLECTOR_RUN_TIMEOUT_MS,
      async execute() {
        const result = await opts.scheduler.tick();
        if (result.failed > 0) {
          opts.log?.warn?.({ result }, '[feat-trajectory-collector] completed with failures');
        } else if (result.applied > 0) {
          opts.log?.info?.(
            { result },
            `[feat-trajectory-collector] tick applied ${result.applied} snapshots (${result.featsInStore} feats in store)`,
          );
        }
      },
    },
    state: { runLedger: 'sqlite' },
    outcome: { whenNoSignal: 'drop' },
    enabled: () => true,
  };
}
