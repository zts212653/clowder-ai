import type { DurableGateRecoveryRow } from './durable-managed-gate-recovery-store.js';

export function durableGateSleepOverlapMs(
  intervals: readonly { startedAt: number; endedAt: number }[],
  from: number,
  to: number,
): number {
  const segments = intervals
    .map((interval) => [Math.max(from, interval.startedAt), Math.min(to, interval.endedAt)] as const)
    .filter(([start, end]) => end > start)
    .sort(([left], [right]) => left - right);
  let total = 0;
  let cursorStart: number | null = null;
  let cursorEnd = 0;
  for (const [start, end] of segments) {
    if (cursorStart === null) {
      cursorStart = start;
      cursorEnd = end;
    } else if (start <= cursorEnd) {
      cursorEnd = Math.max(cursorEnd, end);
    } else {
      total += cursorEnd - cursorStart;
      cursorStart = start;
      cursorEnd = end;
    }
  }
  return total + (cursorStart === null ? 0 : cursorEnd - cursorStart);
}

export function durableGateRawOutcomeIsAmbiguous(mutation: string, rawOutcome: unknown): boolean {
  if (mutation !== 'exit' || rawOutcome === undefined) return false;
  if (!rawOutcome || typeof rawOutcome !== 'object' || Array.isArray(rawOutcome)) return true;
  const outcome = rawOutcome as Record<string, unknown>;
  const code = typeof outcome.code === 'number' ? outcome.code : outcome.exitCode;
  return (code !== 0 && code !== 124) || outcome.signal != null || outcome.error != null;
}

export function durableGateRecoveryRowVersion(row: DurableGateRecoveryRow): string {
  return JSON.stringify([
    row.state,
    row.pause_epoch,
    row.last_observed_at,
    row.reconcile_deadline_at,
    row.terminal_intent,
    row.frozen_identity_json,
    row.last_evidence_id,
    row.updated_at,
  ]);
}
