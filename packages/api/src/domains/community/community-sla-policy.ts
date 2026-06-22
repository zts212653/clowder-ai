/**
 * Community SLA Policy — pure evaluation functions (F168 Phase D, D4)
 *
 * Produces SLA findings for projections that exceed time thresholds:
 *   - case-fixed-unreported:    fixed state exceeds fixedUnreportedAfterMs
 *                               without a public comment or closure waiver
 *   - stale-awaiting-external:  awaiting_external exceeds policy and no
 *                               recent external activity
 *   - stale-needs-info:         needs_info exceeds needsInfoStaleAfterMs
 *
 * All functions are pure — no IO, no Redis, no side-effects.
 * Callers pass in `now` to keep evaluation deterministic in tests.
 */

import type { CommunityObjectProjection } from '@cat-cafe/shared';

// ---------------------------------------------------------------------------
// Policy shape
// ---------------------------------------------------------------------------

export interface SlaPolicy {
  /** Threshold before `fixed` without report/waiver becomes a finding (ms). */
  fixedUnreportedAfterMs: number;
  /** Threshold before stale `awaiting_external` becomes a finding (ms). */
  awaitingExternalStaleAfterMs: number;
  /** Threshold before stale `needs_info` becomes a finding (ms). */
  needsInfoStaleAfterMs: number;
}

/** Conservative defaults (7d / 14d / 14d). Tunable after alpha observation. */
export const DEFAULT_SLA_POLICY: SlaPolicy = {
  fixedUnreportedAfterMs: 7 * 86_400_000,
  awaitingExternalStaleAfterMs: 14 * 86_400_000,
  needsInfoStaleAfterMs: 14 * 86_400_000,
};

// ---------------------------------------------------------------------------
// Finding shape (shared with CommunityReconciliationFindingStore)
// ---------------------------------------------------------------------------

export type SlaFindingKind = 'case-fixed-unreported' | 'stale-awaiting-external' | 'stale-needs-info';

export interface SlaFinding {
  /** Stable deterministic ID: `sla:{subjectKey}:{findingKind}` */
  findingId: string;
  subjectKey: string;
  findingKind: SlaFindingKind;
  severity: 'warning';
  /** Human-readable explanation for the board/operator. */
  message: string;
}

// ---------------------------------------------------------------------------
// Pure evaluation
// ---------------------------------------------------------------------------

type SlaPick = Pick<
  CommunityObjectProjection,
  'subjectKey' | 'state' | 'updatedAt' | 'lastExternalActivityAt' | 'lastPublicCommentAt' | 'closureWaiver'
>;

/**
 * Evaluate SLA findings for a single projection snapshot.
 * Returns an empty array when no SLA violation applies.
 */
export function evaluateSlaFindings(projection: SlaPick, policy: SlaPolicy, now: number): SlaFinding[] {
  const findings: SlaFinding[] = [];

  if (projection.state === 'fixed') {
    const elapsed = now - projection.updatedAt;
    const hasReport = projection.lastPublicCommentAt !== null;
    const hasWaiver = projection.closureWaiver !== null;
    if (elapsed > policy.fixedUnreportedAfterMs && !hasReport && !hasWaiver) {
      findings.push({
        findingId: `sla:${projection.subjectKey}:case-fixed-unreported`,
        subjectKey: projection.subjectKey,
        findingKind: 'case-fixed-unreported',
        severity: 'warning',
        message: `Case has been fixed for ${Math.floor(elapsed / 86_400_000)}d without being reported or waived.`,
      });
    }
  }

  if (projection.state === 'awaiting_external') {
    // Use the later of declaration time and last external activity — old activity
    // that predates entry into awaiting_external should not cause immediate SLA firing.
    const lastActivity = Math.max(projection.lastExternalActivityAt ?? 0, projection.updatedAt);
    const elapsed = now - lastActivity;
    if (elapsed > policy.awaitingExternalStaleAfterMs) {
      findings.push({
        findingId: `sla:${projection.subjectKey}:stale-awaiting-external`,
        subjectKey: projection.subjectKey,
        findingKind: 'stale-awaiting-external',
        severity: 'warning',
        message: `Case has been awaiting external response for ${Math.floor(elapsed / 86_400_000)}d with no activity.`,
      });
    }
  }

  if (projection.state === 'needs_info') {
    const elapsed = now - projection.updatedAt;
    if (elapsed > policy.needsInfoStaleAfterMs) {
      findings.push({
        findingId: `sla:${projection.subjectKey}:stale-needs-info`,
        subjectKey: projection.subjectKey,
        findingKind: 'stale-needs-info',
        severity: 'warning',
        message: `Case has needed info for ${Math.floor(elapsed / 86_400_000)}d with no update.`,
      });
    }
  }

  return findings;
}
