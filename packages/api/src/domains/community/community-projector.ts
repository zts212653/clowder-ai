/**
 * CommunityProjector — consumes events → calls state machine → writes projection
 * (F168 Phase A — Task 4)
 *
 * Responsibilities:
 *  - apply(event): read projection → transition() → handle side-effects → save
 *  - rebuild(subjectKey): delete projection → replay full log
 *  - rebuildAll(): rebuild all subjects via listSubjects()
 *
 * Invariants:
 *  - Events are NEVER deleted from the log (event facts are immutable).
 *  - A rejected transition (closure_invariant) records lastRejectedEvent but
 *    does NOT change projection state.
 *  - case.waived side-effect: stores closureWaiver on projection (no state change).
 *  - case.reported side-effect: sets lastPublicCommentAt to event.at.
 */

import type { CommunityEvent, CommunityObjectProjection, CommunityObjectState } from '@cat-cafe/shared';
import type { ICommunityEventLog } from './CommunityEventLog.js';
import type { ICommunityObjectStore } from './CommunityObjectStore.js';
import { parseLinkedIssues } from './community-link-parser.js';
import { transition } from './community-state-machine.js';

// ---------------------------------------------------------------------------
// Parse subjectKey → repo/type/number
// ---------------------------------------------------------------------------

function parseSubjectKey(subjectKey: string): {
  repo: string;
  type: 'issue' | 'pr';
  number: number;
} {
  // Format: "issue:owner/repo#42"  |  "pr:owner/repo#7"
  const match = /^(issue|pr):(.+)#(\d+)$/.exec(subjectKey);
  if (!match) throw new Error(`Invalid subjectKey: ${subjectKey}`);
  return {
    type: match[1] as 'issue' | 'pr',
    repo: match[2],
    number: parseInt(match[3], 10),
  };
}

// ---------------------------------------------------------------------------
// Default projection factory
// ---------------------------------------------------------------------------

function createProjection(
  subjectKey: string,
  initialState: CommunityObjectState,
  now: number,
): CommunityObjectProjection {
  const { repo, type, number } = parseSubjectKey(subjectKey);
  return {
    repo,
    type,
    number,
    subjectKey,
    state: initialState,
    ownerThreadId: null,
    ownerRole: null,
    nextOwner: 'none',
    lastExternalActivityAt: null,
    lastPublicCommentAt: null,
    linkedIssues: [],
    linkedPrs: [],
    closureWaiver: null,
    appliedEventCount: 0,
    lastRejectedEvent: null,
    deliveryCursor: null,
    createdAt: now,
    updatedAt: now,
  };
}

// ---------------------------------------------------------------------------
// Projector
// ---------------------------------------------------------------------------

export class CommunityProjector {
  constructor(
    private readonly eventLog: ICommunityEventLog,
    private readonly objectStore: ICommunityObjectStore,
  ) {}

  /**
   * Apply a single event to the projection.
   * The event MUST already be in the event log (append first).
   */
  async apply(event: CommunityEvent): Promise<void> {
    const now = event.at;
    const existing = await this.objectStore.get(event.subjectKey);
    const proj: CommunityObjectProjection = existing ?? createProjection(event.subjectKey, 'new', now);

    const snapshot = {
      lastPublicCommentAt: proj.lastPublicCommentAt,
      closureWaiver: proj.closureWaiver,
    };

    const result = transition(proj.state, event, snapshot);

    if (!result.ok) {
      if (event.classification === 'informational') {
        // Internal calibration events (eval records) are not external activity —
        // skip projection entirely so rebuild() doesn't corrupt lastExternalActivityAt.
        if (event.kind === 'case.route_decision_eval') {
          return;
        }
        // Cloud R2 P2b: informational activity events (issue.commented, issue.labeled,
        // pr.review_submitted) have no state-machine transition. Do NOT set lastRejectedEvent
        // (that would pollute observability data with benign activity). Instead, update
        // lastExternalActivityAt so the community board can surface the latest activity time.
        const updated: CommunityObjectProjection = {
          ...proj,
          lastExternalActivityAt: event.at,
          updatedAt: now,
        };
        await this.objectStore.save(updated);
        return;
      }
      // State-changing event rejected — record for observability, do not change state
      const updated: CommunityObjectProjection = {
        ...proj,
        lastRejectedEvent: event,
        updatedAt: now,
      };
      await this.objectStore.save(updated);
      return;
    }

    // Accepted — apply side effects then update state
    const updated: CommunityObjectProjection = {
      ...proj,
      state: result.next,
      appliedEventCount: proj.appliedEventCount + 1,
      lastRejectedEvent: null,
      updatedAt: now,
    };

    // Side-effect: informational events (issue.commented, pr.review_submitted, etc.)
    // always update lastExternalActivityAt, even when they cause a state transition
    // (e.g. awaiting_external → in_progress restore on external actor comment).
    if (event.classification === 'informational') {
      updated.lastExternalActivityAt = event.at;
    }

    // Side-effect: case.reported → set lastPublicCommentAt
    if (event.kind === 'case.reported') {
      updated.lastPublicCommentAt = event.at;
    }

    // Side-effect: case.waived → store waiver payload
    if (event.kind === 'case.waived') {
      const p = event.payload as { reason: string; actor: string; evidence: string };
      updated.closureWaiver = { reason: p.reason, actor: p.actor, evidence: p.evidence };
    }

    // Side-effect: case.bootstrap → set ownerThreadId / ownerRole / linkedPrs from payload
    if (event.kind === 'case.bootstrap') {
      const p = event.payload as Record<string, unknown>;
      if (typeof p.ownerThreadId === 'string') updated.ownerThreadId = p.ownerThreadId;
      if (typeof p.ownerRole === 'string') updated.ownerRole = p.ownerRole;

      // P1-4 fix: extract linkedPrNumbers from originalRecord and populate issue linkedPrs
      const originalRecord = p.originalRecord as Record<string, unknown> | undefined;
      const rawLinkedPrs = originalRecord?.linkedPrNumbers;
      if (Array.isArray(rawLinkedPrs) && rawLinkedPrs.length > 0) {
        const prNums: number[] = rawLinkedPrs.filter((n): n is number => typeof n === 'number');
        updated.linkedPrs = [...new Set([...updated.linkedPrs, ...prNums])];
        // Cross-populate: each linked PR projection gets this issue's number in linkedIssues.
        // NOTE: during apply() this happens inline; rebuildAll() re-runs this in a second pass
        // (after all subjects are rebuilt) to ensure order-independence.
        await this.applyBootstrapCrossPopulate(event, prNums, now);
      }
    }

    // Side-effect: case.routed → capture ownerRole / ownerThreadId from payload
    if (event.kind === 'case.routed') {
      const p = event.payload as Record<string, unknown>;
      if (typeof p.ownerThreadId === 'string') updated.ownerThreadId = p.ownerThreadId;
      if (typeof p.ownerRole === 'string') updated.ownerRole = p.ownerRole;
    }

    // Side-effect: pr.opened → parse PR body for closing keywords → populate linkedIssues
    // This fixes the Phase A cascade dead-穴: linked issues discovered via body parsing
    // (not bootstrap) now receive the pr.merged cascade when the PR is later merged.
    if (event.kind === 'pr.opened') {
      const p = event.payload as Record<string, unknown>;
      // Cloud R4 P1-2: GitHub only auto-closes issues for PRs targeting the default branch.
      // isDefaultBranchPr=false → skip closing-keyword parsing (release-branch PRs must not
      // mark issues fixed). undefined = backward-compat (old events without the field) → parse.
      if (p.isDefaultBranchPr !== false) {
        const linked = parseLinkedIssues(p.body as string | null | undefined);
        if (linked.length > 0) {
          updated.linkedIssues = [...new Set([...updated.linkedIssues, ...linked])];
        }
      }
    }

    // Cloud R2 P2a: pr.merged → also parse body for late-added closing keywords
    // When a PR is opened without closing keywords and the author edits the description
    // before merging, the pr.merged payload includes the current body. Parse it here so the
    // cascade below can reach issues that were not in linkedIssues at open time.
    // Cloud R4 P1-1: body-enrichment events (sourceEventId ending in :body-enrichment) also
    // reach this branch; they carry the same kind='pr.merged' but with a distinct event id,
    // allowing late-discovered linked issues to be cascaded after the poller-won-race scenario.
    if (event.kind === 'pr.merged') {
      const p = event.payload as Record<string, unknown>;
      // Cloud R4 P1-2: same default-branch gate as pr.opened — skip on non-default-branch PRs.
      if (p.isDefaultBranchPr !== false && p.body !== null && p.body !== undefined) {
        const linked = parseLinkedIssues(p.body as string | null | undefined);
        if (linked.length > 0) {
          updated.linkedIssues = [...new Set([...updated.linkedIssues, ...linked])];
        }
      }
    }

    await this.objectStore.save(updated);

    // F168 Phase A: cascade pr.merged → linked issues → fixed
    // linkedIssues contains issue NUMBERS (same repo as PR). Cascade only on fresh apply.
    if (event.kind === 'pr.merged' && updated.linkedIssues.length > 0) {
      let prRepo: string | null = null;
      try {
        prRepo = parseSubjectKey(event.subjectKey).repo;
      } catch {
        /* ignore */
      }
      if (prRepo) {
        for (const issueNumber of updated.linkedIssues) {
          try {
            const linkedIssueKey = `issue:${prRepo}#${issueNumber}`;
            const cascadeEvent: CommunityEvent = {
              sourceEventId: `${event.sourceEventId}:cascade:${linkedIssueKey}`,
              subjectKey: linkedIssueKey,
              kind: 'pr.merged',
              classification: 'state-changing',
              payload: { linkedPr: event.subjectKey, title: (event.payload as Record<string, unknown>).title ?? '' },
              at: event.at,
            };
            const { appended } = await this.eventLog.append(cascadeEvent);
            if (appended) {
              // Recursive apply for the linked issue — safe since issues don't cascade further
              await this.apply(cascadeEvent);
            }
          } catch {
            // Best-effort — cascade failure does not affect PR projection
          }
        }
      }
    }
  }

  /**
   * Cross-populate linked PR projections from a case.bootstrap event.
   * Extracted as a private method so rebuildAll can re-run it after all subjects
   * are rebuilt, ensuring order-independence.
   */
  private async applyBootstrapCrossPopulate(event: CommunityEvent, prNums: number[], now: number): Promise<void> {
    const { type: subjectType, number: issueNum, repo: issueRepo } = parseSubjectKey(event.subjectKey);
    if (subjectType !== 'issue') return;
    for (const prNum of prNums) {
      try {
        const prSubjectKey = `pr:${issueRepo}#${prNum}`;
        const existingPrProj = await this.objectStore.get(prSubjectKey);
        const prProj = existingPrProj ?? createProjection(prSubjectKey, 'new', now);
        if (!prProj.linkedIssues.includes(issueNum)) {
          // Do NOT override updatedAt — cross-populate is metadata, not a state change.
          // The PR's own events already set updatedAt correctly. Overriding with
          // the (older) bootstrap event time would regress updatedAt after rebuildAll.
          await this.objectStore.save({
            ...prProj,
            linkedIssues: [...prProj.linkedIssues, issueNum],
          });
        }
      } catch {
        // Best-effort — cross-populate failure does not affect issue projection
      }
    }
  }

  /**
   * Rebuild projection for a single subject from the event log.
   * Deletes existing projection first, then replays all events.
   */
  async rebuild(subjectKey: string): Promise<void> {
    await this.objectStore.delete(subjectKey);
    const events = await this.eventLog.read(subjectKey);
    for (const event of events) {
      await this.apply(event);
    }
  }

  /**
   * Rebuild projections for all known subjects.
   *
   * Two-pass strategy to ensure order-independence for cross-subject side effects:
   * - Pass 1: rebuild every subject from its own events. This includes inline
   *   cross-population during apply(), but since subjects are rebuilt in arbitrary
   *   order, the cross-populated data on a PR may be overwritten when that PR is
   *   later rebuilt.
   * - Pass 2: re-apply all case.bootstrap cross-population AFTER all subjects are
   *   stable, so linkedIssues on PR projections reflect the correct final state
   *   regardless of which subject was rebuilt first.
   */
  async rebuildAll(): Promise<void> {
    const subjects = await this.eventLog.listSubjects();

    // Pass 1: rebuild each subject from its own events
    for (const subjectKey of subjects) {
      await this.rebuild(subjectKey);
    }

    // Pass 2: re-apply cross-subject bootstrap cross-population (order-safe)
    for (const subjectKey of subjects) {
      const events = await this.eventLog.read(subjectKey);
      for (const event of events) {
        if (event.kind !== 'case.bootstrap') continue;
        const p = event.payload as Record<string, unknown>;
        const originalRecord = p.originalRecord as Record<string, unknown> | undefined;
        const rawLinkedPrs = originalRecord?.linkedPrNumbers;
        if (!Array.isArray(rawLinkedPrs) || rawLinkedPrs.length === 0) continue;
        const prNums: number[] = rawLinkedPrs.filter((n): n is number => typeof n === 'number');
        await this.applyBootstrapCrossPopulate(event, prNums, event.at);
      }
    }

    // Pass 3: re-cascade pr.merged for PRs that are now in 'fixed' state but whose linked
    // issues didn't receive the cascade during pass 1 (because linkedIssues was empty when
    // pr.merged was first replayed — pass 2 hadn't restored the links yet).
    // append() is idempotent via sourceEventId dedup, so already-cascaded issues are no-ops.
    for (const subjectKey of subjects) {
      if (!subjectKey.startsWith('pr:')) continue;
      const prProj = await this.objectStore.get(subjectKey);
      if (!prProj || prProj.state !== 'fixed' || prProj.linkedIssues.length === 0) continue;

      let prRepo: string | null = null;
      try {
        prRepo = parseSubjectKey(subjectKey).repo;
      } catch {
        /* skip malformed key */
      }
      if (!prRepo) continue;

      const prEvents = await this.eventLog.read(subjectKey);
      const mergeEvent = prEvents.find((e) => e.kind === 'pr.merged');
      if (!mergeEvent) continue;

      for (const issueNumber of prProj.linkedIssues) {
        try {
          const linkedIssueKey = `issue:${prRepo}#${issueNumber}`;
          const cascadeEvent: CommunityEvent = {
            sourceEventId: `${mergeEvent.sourceEventId}:cascade:${linkedIssueKey}`,
            subjectKey: linkedIssueKey,
            kind: 'pr.merged',
            classification: 'state-changing',
            payload: { linkedPr: subjectKey, title: (mergeEvent.payload as Record<string, unknown>).title ?? '' },
            at: mergeEvent.at,
          };
          const { appended } = await this.eventLog.append(cascadeEvent);
          if (appended) {
            await this.apply(cascadeEvent);
          }
        } catch {
          // Best-effort — cascade failure does not affect PR projection
        }
      }
    }
  }
}
