/**
 * community-bootstrap — migrate CommunityIssueStore records to Event Log + projection
 * (F168 Phase A — Task 5)
 *
 * Each legacy issue record is synthesised into a single `case.bootstrap` event.
 * The event is idempotent: sourceEventId = `bootstrap:{subjectKey}` — re-runs
 * produce no duplicate events (CommunityEventLog dedup via seen SET).
 *
 * Closure invariant is EXEMPTED for bootstrap events (historical data — the
 * state machine handles this via the BOOTSTRAP branch in transition()).
 *
 * Legacy IssueState → CommunityObjectState mapping:
 *   unreplied        → new
 *   discussing       → triaged
 *   pending-decision → triaged
 *   accepted         → routed
 *   declined         → declined
 *   closed           → closed
 */

import type { CommunityEvent, CommunityObjectState } from '@cat-cafe/shared';
import type { ICommunityEventLog } from './CommunityEventLog.js';
import type { ICommunityObjectStore } from './CommunityObjectStore.js';
import { CommunityProjector } from './community-projector.js';

// ---------------------------------------------------------------------------
// Legacy state mapping
// ---------------------------------------------------------------------------

const STATE_MAP: Record<string, CommunityObjectState> = {
  unreplied: 'new',
  discussing: 'triaged',
  'pending-decision': 'triaged',
  accepted: 'routed',
  declined: 'declined',
  closed: 'closed',
};

// ---------------------------------------------------------------------------
// Minimal shape we need from a legacy issue record
// ---------------------------------------------------------------------------

interface LegacyIssueRecord {
  repo: string;
  issueNumber: number;
  state: string;
  assignedThreadId: string | null;
  assignedCatId?: string | null;
  [key: string]: unknown;
}

// ---------------------------------------------------------------------------
// Bootstrap options
// ---------------------------------------------------------------------------

export interface BootstrapOptions {
  /** Legacy issue records to migrate. */
  issues: LegacyIssueRecord[];
  eventLog: ICommunityEventLog;
  objectStore: ICommunityObjectStore;
  /**
   * If true, compute and return the would-create report without writing
   * anything to Redis.
   */
  dryRun: boolean;
}

export interface BootstrapReportEntry {
  subjectKey: string;
  mappedState: CommunityObjectState;
  originalState: string;
  wouldCreate: boolean;
}

// ---------------------------------------------------------------------------
// Main function
// ---------------------------------------------------------------------------

export async function communityBootstrap(opts: BootstrapOptions): Promise<BootstrapReportEntry[]> {
  const { issues, eventLog, objectStore, dryRun } = opts;
  const report: BootstrapReportEntry[] = [];

  const projector = new CommunityProjector(eventLog, objectStore);

  for (const issue of issues) {
    const subjectKey = `issue:${issue.repo}#${issue.issueNumber}`;
    const mappedState: CommunityObjectState = STATE_MAP[issue.state] ?? 'new';

    const sourceEventId = `bootstrap:${subjectKey}`;

    // Check if already bootstrapped (dedup would reject on re-run)
    // We check by reading the log — if a bootstrap event exists, skip
    const existing = await eventLog.read(subjectKey);
    const alreadyBootstrapped = existing.some((e) => e.kind === 'case.bootstrap' && e.sourceEventId === sourceEventId);

    report.push({
      subjectKey,
      mappedState,
      originalState: issue.state,
      wouldCreate: !alreadyBootstrapped,
    });

    if (dryRun || alreadyBootstrapped) continue;

    const event: CommunityEvent = {
      sourceEventId,
      subjectKey,
      kind: 'case.bootstrap',
      classification: 'state-changing',
      payload: {
        mappedState,
        originalState: issue.state,
        ownerThreadId: issue.assignedThreadId,
        ownerRole: issue.assignedCatId ?? null,
        originalRecord: issue,
      },
      at: Date.now(),
    };

    const { appended } = await eventLog.append(event);
    if (appended) {
      await projector.apply(event);
    }
  }

  return report;
}
