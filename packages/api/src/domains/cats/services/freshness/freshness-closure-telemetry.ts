import {
  freshnessClosureStage,
  freshnessClosureTransition,
  freshnessReplayFence,
  freshnessSuccessorPreflightCanceled,
} from '../../../../infrastructure/telemetry/instruments.js';

export type FreshnessClosureTransitionKind = 'opened' | 'superseded' | 'committed' | 'blocked' | 'retried';

const totals: Record<FreshnessClosureTransitionKind, number> = {
  opened: 0,
  superseded: 0,
  committed: 0,
  blocked: 0,
  retried: 0,
};
let successorPreflightCanceledTotal = 0;
let replayFenceTotal = 0;
export type FreshnessClosureStageKind = 'formal_committed' | 'preflight_blocked';
const stageTotals: Record<FreshnessClosureStageKind, number> = {
  formal_committed: 0,
  preflight_blocked: 0,
};

export function recordFreshnessClosureTransition(kind: FreshnessClosureTransitionKind): void {
  totals[kind] += 1;
  freshnessClosureTransition.add(1, { transition: kind });
}

export function recordFreshnessSuccessorPreflightCanceled(reason: string): void {
  successorPreflightCanceledTotal += 1;
  freshnessSuccessorPreflightCanceled.add(1, { reason });
}

export function recordFreshnessReplayFence(): void {
  replayFenceTotal += 1;
  freshnessReplayFence.add(1);
}

export function recordFreshnessClosureStage(kind: FreshnessClosureStageKind): void {
  stageTotals[kind] += 1;
  freshnessClosureStage.add(1, { stage: kind });
}

export function getFreshnessClosureTelemetrySnapshot() {
  return { ...totals, ...stageTotals, successorPreflightCanceledTotal, replayFenceTotal };
}

export function resetFreshnessClosureTelemetryForTest(): void {
  for (const kind of Object.keys(totals) as FreshnessClosureTransitionKind[]) totals[kind] = 0;
  successorPreflightCanceledTotal = 0;
  replayFenceTotal = 0;
  for (const kind of Object.keys(stageTotals) as FreshnessClosureStageKind[]) stageTotals[kind] = 0;
}
