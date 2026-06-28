/**
 * CommunityReconciler — pure reconciliation engine (F168 Phase D, D3)
 *
 * Reads existing CommunityObjectProjection snapshots and injected GitHub
 * subject snapshots, then emits deterministic actions:
 *   - Missing fact events (issue.closed, pr.merged, pr.closed, issue.reopened)
 *   - Drift findings (github-closed-case-open, case-closed-github-open, etc.)
 *   - SLA findings (via evaluateSlaFindings)
 *
 * Guarantees:
 *   - Never calls GitHub mutation APIs
 *   - Never writes CommunityObjectStore directly
 *   - First-run baseline produces no events/findings
 *   - Stable sourceEventId for deterministic dedup
 *   - Fetch failure doesn't clear existing findings
 *
 * All functions are pure — no IO, no Redis, no side-effects.
 */

import type { CommunityEvent, CommunityObjectProjection } from '@cat-cafe/shared';
import { DEFAULT_SLA_POLICY, evaluateSlaFindings, type SlaPolicy } from './community-sla-policy.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Minimal GitHub state snapshot for reconciliation. */
export interface GitHubSnapshot {
  state: 'open' | 'closed';
  closedAt: string | null;
  mergedAt: string | null;
}

export interface ReconcilerInput {
  projections: CommunityObjectProjection[];
  githubSnapshots: Map<string, GitHubSnapshot>;
  baselineEstablished: boolean;
  now: number;
  slaPolicy?: SlaPolicy;
}

export interface ReconcilerFinding {
  findingId: string;
  subjectKey: string;
  findingKind: string;
  severity: string;
  message: string;
}

export interface ReconcilerResult {
  /** Events to append to the Event Log (caller runs eventLog.append + projector.apply). */
  events: CommunityEvent[];
  /** Findings to upsert into FindingStore (caller runs findingStore.upsert). */
  findings: ReconcilerFinding[];
  /** Warnings for subjects that could not be reconciled (fetch failure, etc.). */
  warnings: string[];
  /** True when this was a first-run baseline (no events/findings emitted). */
  isBaseline: boolean;
}

// ---------------------------------------------------------------------------
// Terminal states — projections in these states are not drift-checked
// ---------------------------------------------------------------------------

/** States where the case is "done" from the community board perspective. */
const TERMINAL_CASE_STATES = new Set(['closed', 'declined']);

/**
 * States where the case is considered "active" and should be reconciled
 * against GitHub state for drift detection.
 */
function isActiveCaseState(state: string): boolean {
  return !TERMINAL_CASE_STATES.has(state);
}

// ---------------------------------------------------------------------------
// Stable sourceEventId factory
// ---------------------------------------------------------------------------

/**
 * Deterministic event ID for reconciler-generated events.
 * Format: `reconciler:{subjectKey}:{kind}:{factKey}`
 * Stable across repeated runs for the same missing fact; unique across
 * distinct facts (e.g., different closedAt timestamps after a reopen cycle).
 */
function reconcilerEventId(subjectKey: string, kind: string, factKey?: string): string {
  const base = `reconciler:${subjectKey}:${kind}`;
  return factKey ? `${base}:${factKey}` : base;
}

// ---------------------------------------------------------------------------
// Pure reconciliation
// ---------------------------------------------------------------------------

export function reconcile(input: ReconcilerInput): ReconcilerResult {
  const { projections, githubSnapshots, baselineEstablished, now } = input;
  const policy = input.slaPolicy ?? DEFAULT_SLA_POLICY;

  // First-run baseline: mark as baseline, create nothing
  if (!baselineEstablished) {
    return { events: [], findings: [], warnings: [], isBaseline: true };
  }

  const events: CommunityEvent[] = [];
  const findings: ReconcilerFinding[] = [];
  const warnings: string[] = [];

  for (const projection of projections) {
    // ── SLA findings (always evaluated, regardless of drift or fetch) ───
    // SLA uses only projection state/timestamps — independent of GitHub.
    const slaFindings = evaluateSlaFindings(projection, policy, now);
    for (const sf of slaFindings) {
      findings.push(sf);
    }

    const ghSnap = githubSnapshots.get(projection.subjectKey);

    // ── Fetch failure: no GitHub snapshot available ──────────────────────
    if (!ghSnap) {
      warnings.push(`No GitHub snapshot for ${projection.subjectKey} — skipped reconciliation`);
      continue;
    }

    // ── Drift detection ─────────────────────────────────────────────────

    const caseIsActive = isActiveCaseState(projection.state);
    const ghIsClosed = ghSnap.state === 'closed';
    const ghIsOpen = ghSnap.state === 'open';

    // D3.5: GitHub closed while case is active (not yet closed/declined)
    if (caseIsActive && ghIsClosed) {
      const eventKind = resolveCloseEventKind(projection.type, ghSnap);
      // Include closedAt/mergedAt as fact key so reopen→close cycles produce unique IDs
      const factKey = ghSnap.mergedAt ?? ghSnap.closedAt ?? '';
      const sourceEventId = reconcilerEventId(projection.subjectKey, eventKind, factKey);

      events.push({
        sourceEventId,
        subjectKey: projection.subjectKey,
        kind: eventKind,
        classification: 'state-changing',
        payload: {
          closedAt: ghSnap.closedAt,
          mergedAt: ghSnap.mergedAt,
          source: 'reconciler',
        },
        at: ghSnap.closedAt ? new Date(ghSnap.closedAt).getTime() : now,
      });

      findings.push({
        findingId: `reconcile:${projection.subjectKey}:github-closed-case-open`,
        subjectKey: projection.subjectKey,
        findingKind: 'github-closed-case-open',
        severity: 'warning',
        message: `GitHub ${projection.type} #${projection.number} is ${eventKind === 'pr.merged' ? 'merged' : 'closed'} but case state is '${projection.state}'.`,
      });
    }

    // D3.7: GitHub reopened after internal close (issues only — PRs can't reopen)
    // Takes priority over D3.6 for closed issues — the reopened event is the
    // concrete fact; D3.6 is the generic drift signal for PRs/declined.
    if (projection.state === 'closed' && ghIsOpen && projection.type === 'issue') {
      // Use projection.updatedAt as fact key — stable across retries (projection
      // unchanged if apply() fails after append), unique across close→reopen cycles
      // (each close event sets a different updatedAt). No GitHub timestamp for reopens.
      const sourceEventId = reconcilerEventId(projection.subjectKey, 'issue.reopened', String(projection.updatedAt));
      events.push({
        sourceEventId,
        subjectKey: projection.subjectKey,
        kind: 'issue.reopened',
        classification: 'state-changing',
        payload: {
          source: 'reconciler',
        },
        at: now,
      });

      findings.push({
        findingId: `reconcile:${projection.subjectKey}:github-reopened-case-closed`,
        subjectKey: projection.subjectKey,
        findingKind: 'github-reopened-case-closed',
        severity: 'warning',
        message: `GitHub issue #${projection.number} was reopened but case was closed.`,
      });
    }

    // D3.6: Case closed/declined while GitHub is open — no fake event, just finding.
    // Skipped for closed issues (handled by D3.7 above).
    else if (!caseIsActive && ghIsOpen) {
      findings.push({
        findingId: `reconcile:${projection.subjectKey}:case-closed-github-open`,
        subjectKey: projection.subjectKey,
        findingKind: 'case-closed-github-open',
        severity: 'warning',
        message: `Case state is '${projection.state}' but GitHub ${projection.type} #${projection.number} is still open.`,
      });
    }
  }

  return { events, findings, warnings, isBaseline: false };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function resolveCloseEventKind(
  type: 'issue' | 'pr',
  ghSnap: GitHubSnapshot,
): 'issue.closed' | 'pr.merged' | 'pr.closed' {
  if (type === 'issue') return 'issue.closed';
  return ghSnap.mergedAt ? 'pr.merged' : 'pr.closed';
}
