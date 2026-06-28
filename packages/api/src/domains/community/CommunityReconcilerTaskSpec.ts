/**
 * CommunityReconcilerTaskSpec — schedule-driven reconciliation (F168 Phase D, D3)
 *
 * Reads CommunityObjectProjection snapshots + live GitHub state for each
 * tracked subject, runs the pure `reconcile()` engine, then:
 *   1. Appends missing fact events to the Event Log
 *   2. Calls projector.apply for each newly appended event
 *   3. Upserts findings into CommunityReconciliationFindingStore
 *   4. Auto-resolves findings that are no longer present
 *
 * Redis-gated like repo-scan: requires objectStore, eventLog, projector,
 * and findingStore plus GitHub fetch functions.
 *
 * Note: The reconciler runs the pure `reconcile()` across ALL subjects in
 * the gate phase (collecting work items), then processes all events + findings
 * in a single execute call. This is because drift detection benefits from
 * batch context (e.g., resolveAbsent needs the full finding set per subject).
 * The TaskSpec_P1 execute is called once with a batch signal.
 */

import type { CommunityObjectProjection } from '@cat-cafe/shared';
import type { ExecuteContext, GateCtx, TaskSpec_P1 } from '../../infrastructure/scheduler/types.js';
import type { ICommunityEventLog } from './CommunityEventLog.js';
import type { ICommunityObjectStore } from './CommunityObjectStore.js';
import { type GitHubSnapshot, reconcile } from './CommunityReconciler.js';
import type { CommunityReconciliationFindingStore } from './CommunityReconciliationFindingStore.js';
import type { SlaPolicy } from './community-sla-policy.js';

// ---------------------------------------------------------------------------
// Minimal projector interface
// ---------------------------------------------------------------------------

interface IProjectorApply {
  apply(event: Parameters<ICommunityEventLog['append']>[0]): Promise<void>;
}

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

export interface CommunityReconcilerTaskSpecOptions {
  objectStore: Pick<ICommunityObjectStore, 'get' | 'listSubjectKeys'>;
  eventLog: ICommunityEventLog;
  projector: IProjectorApply;
  findingStore: CommunityReconciliationFindingStore;
  /** Fetch live GitHub state for an issue. */
  fetchIssueState: (repo: string, number: number) => Promise<GitHubSnapshot | null>;
  /** Fetch live GitHub state for a PR. */
  fetchPrState: (repo: string, number: number) => Promise<GitHubSnapshot | null>;
  slaPolicy?: SlaPolicy;
  log: { info(...args: unknown[]): void; warn(...args: unknown[]): void };
  /** Task poll interval (default 10 minutes). */
  pollIntervalMs?: number;
  /** Override task ID for plugin-scoped instances. */
  id?: string;
  /** Track whether baseline has been established across runs. */
  isBaselineEstablished: () => Promise<boolean>;
  markBaselineEstablished: () => Promise<void>;
}

// ---------------------------------------------------------------------------
// Subject key parsing
// ---------------------------------------------------------------------------

interface ParsedSubject {
  type: 'issue' | 'pr';
  repo: string;
  number: number;
}

function parseSubjectKey(subjectKey: string): ParsedSubject | null {
  // Format: issue:owner/repo#N or pr:owner/repo#N
  const match = subjectKey.match(/^(issue|pr):(.+)#(\d+)$/);
  if (!match) return null;
  return {
    type: match[1] as 'issue' | 'pr',
    repo: match[2],
    number: Number(match[3]),
  };
}

// ---------------------------------------------------------------------------
// TaskSpec creation
// ---------------------------------------------------------------------------

/** Signal type for the reconciler batch run. */
interface ReconcilerBatchSignal {
  subjectKeys: string[];
}

export function createCommunityReconcilerTaskSpec(
  opts: CommunityReconcilerTaskSpecOptions,
): TaskSpec_P1<ReconcilerBatchSignal> {
  return {
    id: opts.id ?? 'community-reconciler',
    profile: 'poller',
    trigger: { type: 'interval', ms: opts.pollIntervalMs ?? 600_000 },
    admission: {
      async gate(_ctx: GateCtx) {
        const subjectKeys = await opts.objectStore.listSubjectKeys();
        if (subjectKeys.length === 0) {
          return { run: false, reason: 'no tracked community subjects' };
        }
        // Batch: single work item with all subjects
        return {
          run: true,
          workItems: [
            {
              subjectKey: 'community:reconciler:batch',
              signal: { subjectKeys },
            },
          ],
        };
      },
    },
    run: {
      overlap: 'skip',
      timeoutMs: 120_000,
      async execute(signal: ReconcilerBatchSignal, _subjectKey: string, _ctx: ExecuteContext) {
        const baselineEstablished = await opts.isBaselineEstablished();
        const { subjectKeys } = signal;

        // Fetch all projections + GitHub snapshots
        const projections: CommunityObjectProjection[] = [];
        const githubSnapshots = new Map<string, GitHubSnapshot>();
        // Track subjects with successful GitHub fetches — only these are safe
        // to pass through resolveAbsent (D3.4: fetch failure must not clear findings)
        const fetchSuccessSubjects = new Set<string>();

        for (const sk of subjectKeys) {
          const projection = await opts.objectStore.get(sk);
          if (!projection) continue;

          projections.push(projection);

          const parsed = parseSubjectKey(sk);
          if (!parsed) {
            opts.log.warn(`[reconciler] Cannot parse subjectKey: ${sk}`);
            continue;
          }

          try {
            const fetchFn = parsed.type === 'issue' ? opts.fetchIssueState : opts.fetchPrState;
            const ghSnap = await fetchFn(parsed.repo, parsed.number);
            if (ghSnap) {
              githubSnapshots.set(sk, ghSnap);
            }
            // Mark as successfully fetched even if ghSnap is null (API returned no data)
            // — null is a valid "not found" answer, distinct from a fetch error
            fetchSuccessSubjects.add(sk);
          } catch (err) {
            opts.log.warn(`[reconciler] Failed to fetch GitHub state for ${sk}:`, err);
            // Do NOT add to fetchSuccessSubjects — resolveAbsent must skip this subject
          }
        }

        if (projections.length === 0) return;

        // Run pure reconciliation
        const result = reconcile({
          projections,
          githubSnapshots,
          baselineEstablished,
          now: Date.now(),
          slaPolicy: opts.slaPolicy,
        });

        // Log warnings
        for (const w of result.warnings) {
          opts.log.warn(`[reconciler] ${w}`);
        }

        // Establish baseline on first run — only if ALL projected subjects
        // were fetched successfully. Partial baseline would miss pre-existing
        // drift for failed subjects on the next (non-baseline) run.
        if (result.isBaseline) {
          if (fetchSuccessSubjects.size === projections.length) {
            await opts.markBaselineEstablished();
            opts.log.info(`[reconciler] Baseline established for ${projections.length} subjects`);
          } else {
            opts.log.warn(
              `[reconciler] Baseline deferred: ${fetchSuccessSubjects.size}/${projections.length} subjects fetched successfully`,
            );
          }
          return;
        }

        // Append events to Event Log + projector
        for (const event of result.events) {
          const { appended } = await opts.eventLog.append(event);
          if (appended) {
            await opts.projector.apply(event);
            opts.log.info(`[reconciler] Appended ${event.kind} for ${event.subjectKey}`);
          }
        }

        // Upsert findings
        const currentFindingIds: string[] = [];
        for (const finding of result.findings) {
          await opts.findingStore.upsert(finding);
          currentFindingIds.push(finding.findingId);
        }

        // Auto-resolve absent findings only for subjects with successful GitHub fetches.
        // D3.4: transient fetch failure must not clear existing findings.
        for (const subjectKey of fetchSuccessSubjects) {
          const subjectFindings = currentFindingIds.filter((id) => {
            const finding = result.findings.find((f) => f.findingId === id);
            return finding?.subjectKey === subjectKey;
          });
          await opts.findingStore.resolveAbsent(subjectKey, subjectFindings);
        }

        opts.log.info(
          `[reconciler] Run complete: ${result.events.length} events, ${result.findings.length} findings, ${result.warnings.length} warnings`,
        );
      },
    },
    state: { runLedger: 'sqlite' },
    outcome: { whenNoSignal: 'drop' },
    enabled: () => true,
  };
}
