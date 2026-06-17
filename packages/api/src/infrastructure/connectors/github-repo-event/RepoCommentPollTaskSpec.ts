/**
 * F168 Phase C — C0.3 RepoCommentPollTaskSpec (repo-level comment poller)
 *
 * Collection-only poller that sweeps ALL issue comments across allowlisted repos
 * (including un-routed / untracked issues), closing the per-tracked-issue blind
 * spot of IssueCommentTaskSpec — which only polls issues that already have a
 * registered `issue_tracking` task and therefore never sees comments on issues
 * the engine has not yet routed.
 *
 * Three-path convergence (webhook + per-issue poller + this repo poller):
 *   - Shared dedup key `comment:{repo}#{issueNumber}:{commentId}` (issueCommentEventId)
 *     guarantees a given comment is appended to the event log exactly once,
 *     regardless of which path observes it first.
 *   - CommunityEvent kind 'issue.commented', classification 'informational'.
 *
 * Cursor semantics (INV-9 / INV-10):
 *   - The per-repo cursor is the max comment `updatedAt` (ISO-8601 UTC) observed
 *     so far, passed back to fetchRepoComments as the `since` lower bound. ISO-8601
 *     UTC strings sort lexicographically in chronological order, so plain string
 *     comparison is a safe max.
 *   - The cursor advances on BOTH appended:true and appended:false (dedup) results,
 *     so a duplicate comment can never force an unbounded re-fetch loop (polling
 *     churn). Only a thrown fetch/append error (transient) withholds advancement,
 *     leaving the cursor below the failed comment so the next poll retries it.
 *   - PR conversation comments (surfaced by the repo-level endpoint because PRs are
 *     issues) are NOT appended/projected — they belong to the ReviewFeedbackTaskSpec
 *     track — but they DO advance the cursor, so a repo with PR activity but no new
 *     issue comments can't stall the cursor into re-fetching the same pages every tick
 *     (cloud review R4 P2 — churn).
 *   - The projector is applied ONLY on appended:true. Re-applying an already-seen
 *     event (landed earlier via the webhook / per-issue path) out of temporal order
 *     would wrongly restore awaiting_external → in_progress; projection drift is
 *     repaired via rebuild, never out-of-order replay.
 *
 * Collection-only: append + project happen inside the gate and it always returns
 * { run: false }. Delivery (owner notification) is downstream — IssueCommentRouter
 * fans out from the case projection. An un-routed issue has no owner thread, so
 * delivery is intentionally not this poller's concern.
 */
import type { CommunityEvent } from '@cat-cafe/shared';
import { issueSubjectKey } from '@cat-cafe/shared';
import type { ICommunityEventLog } from '../../../domains/community/CommunityEventLog.js';
import { issueCommentEventId } from '../../../domains/community/community-keys.js';
import type { GateResult, TaskSpec_P1 } from '../../scheduler/types.js';

/** Minimal projector interface — only apply() is needed here. */
interface ICommunityProjectorApply {
  apply(event: CommunityEvent): Promise<void>;
}

/**
 * A GitHub issue comment as surfaced by the repo-level comment listing
 * (GET /repos/{repo}/issues/comments?since=...). Carries the parent issueNumber
 * so the poller can derive the subject key without a second per-issue fetch.
 */
export interface RepoIssueComment {
  issueNumber: number;
  commentId: number;
  author: string;
  authorAssociation: string;
  body: string;
  /** ISO-8601 UTC timestamp — doubles as the per-repo `since` cursor. */
  updatedAt: string;
  /**
   * True when this comment is on a pull request. The repo-level /issues/comments endpoint
   * surfaces PR conversation comments too (PRs are issues in GitHub). PR comments belong to
   * the ReviewFeedbackTaskSpec track, so they are NOT appended/projected here — but they are
   * still fetched (and advance the cursor) so PR-only activity can't stall the cursor and
   * cause an unbounded re-fetch loop (cloud review R4 P2 — churn).
   */
  isPullRequest: boolean;
}

export interface RepoCommentPollTaskSpecOptions {
  readonly eventLog: ICommunityEventLog;
  readonly projector?: ICommunityProjectorApply;
  /**
   * Repo-level comment fetch. `sinceIso` is the per-repo cursor (max updatedAt
   * observed so far); implementations pass it through to the GitHub `since` query
   * parameter to bound the listing.
   */
  readonly fetchRepoComments: (repo: string, sinceIso?: string) => Promise<RepoIssueComment[]>;
  readonly repoAllowlist: string[];
  /** Per-repo collection cursor read (max comment updatedAt, or undefined on first poll). */
  readonly readCursor: (repo: string) => Promise<string | undefined>;
  /** Per-repo collection cursor write. */
  readonly writeCursor: (repo: string, cursor: string) => Promise<void>;
  readonly log: {
    info: (...args: unknown[]) => void;
    warn: (...args: unknown[]) => void;
    error: (...args: unknown[]) => void;
  };
  readonly pollIntervalMs?: number;
  /** F202-2B style: override task ID for plugin-scoped schedule instances. */
  readonly id?: string;
}

/**
 * Poll a single repo's comments and append them to the event log (collection-only).
 * Extracted from the gate loop so gate() cognitive complexity stays bounded.
 * First poll (no cursor) baselines instead of backfilling — see INV-9b / cloud P1-2.
 */
async function pollSingleRepo(opts: RepoCommentPollTaskSpecOptions, repo: string): Promise<void> {
  const since = await opts.readCursor(repo);
  if (since === undefined) {
    // P1-2 (cloud review): baseline the first poll instead of backfilling. With no cursor
    // (first enable / new repo / lost cursor), fetching with no `since` would pull the
    // repo's ENTIRE historical comment set into the event log (poll storm). C0.3's blind
    // spot is NEW un-routed follow-ups, not history — baseline the cursor to now and start
    // capturing forward. (Mirrors RepoScanTaskSpec's baseline-established semantics.)
    const baselineCursor = new Date().toISOString();
    await opts.writeCursor(repo, baselineCursor);
    opts.log.info(`[repo-comment-poll] baselined ${repo} at ${baselineCursor} (skip historical backfill)`);
    return;
  }

  // P2 (cloud review): query with a 1s overlap. GitHub `since` is "after timestamp" +
  // second-granularity; a comment created in the same second as the stored cursor but
  // after the previous paginated response would be skipped forever. Re-query 1s earlier
  // and let dedup by issueCommentEventId absorb the re-fetched overlap. The cursor below
  // still stores the exact max, so it advances normally (no stuck / regression).
  const sinceWithOverlap = new Date(Date.parse(since) - 1000).toISOString();
  const comments = await opts.fetchRepoComments(repo, sinceWithOverlap);
  let maxCursor = since;
  for (const c of comments) {
    // PR conversation comments are surfaced by the repo-level endpoint (PRs are issues in
    // GitHub) but belong to the ReviewFeedbackTaskSpec track — do NOT append/project them
    // here. They still advance the cursor below, so a repo with PR activity but no new issue
    // comments doesn't re-fetch the same pages every tick (cloud review R4 P2 — churn).
    if (!c.isPullRequest) {
      const event: CommunityEvent = {
        sourceEventId: issueCommentEventId(repo, c.issueNumber, c.commentId),
        subjectKey: issueSubjectKey(repo, c.issueNumber),
        kind: 'issue.commented',
        classification: 'informational',
        payload: {
          commentId: c.commentId,
          authorLogin: c.author,
          authorAssociation: c.authorAssociation,
          body: c.body,
        },
        at: Date.now(),
      };

      const { appended } = await opts.eventLog.append(event);
      // Project only newly appended events. A duplicate (appended:false) is already in the
      // log via another path; re-applying it out of temporal order would wrongly restore
      // awaiting_external → in_progress.
      if (appended && opts.projector) {
        await opts.projector.apply(event);
      }
    }

    // Advance cursor over ALL fetched comments (issue AND PR) so neither a duplicate
    // (appended:false) nor a skipped PR comment forces an unbounded re-fetch loop. Only a
    // thrown error withholds advancement, leaving the cursor below the failed comment for retry.
    if (maxCursor === undefined || c.updatedAt > maxCursor) {
      maxCursor = c.updatedAt;
    }
  }

  if (maxCursor !== undefined && maxCursor !== since) {
    await opts.writeCursor(repo, maxCursor);
  }
}

export function repoCommentPollTaskSpec(opts: RepoCommentPollTaskSpecOptions): TaskSpec_P1 {
  return {
    id: opts.id ?? 'repo-comment-poll',
    profile: 'poller',
    trigger: { type: 'interval', ms: opts.pollIntervalMs ?? 60_000 },
    admission: {
      async gate(): Promise<GateResult> {
        for (const repo of opts.repoAllowlist) {
          try {
            await pollSingleRepo(opts, repo);
          } catch (e) {
            // fail-open: one repo's fetch/append failure must not block the others.
            // The cursor is not advanced for this repo, so the next poll retries.
            opts.log.warn(`[repo-comment-poll] failed to poll ${repo}, will retry next tick`, e);
          }
        }

        // Collection-only: all work (append + project) happened above. There is no
        // delivery signal to execute — un-routed issues have no owner thread, and
        // delivery is the downstream router's responsibility.
        return { run: false, reason: 'repo-comment poll: collection-only' };
      },
    },
    run: {
      overlap: 'skip',
      timeoutMs: 30_000,
      // Unreachable by design: the gate never emits workItems (collection-only).
      // The warn surfaces the broken invariant if a future change starts emitting them.
      async execute(): Promise<void> {
        opts.log.warn('[repo-comment-poll] execute() invoked unexpectedly — collection-only poller emits no workItems');
      },
    },
    state: { runLedger: 'sqlite' },
    // Collection-only poller is no-signal by design every tick; recording would
    // flood the run ledger with SKIP_NO_SIGNAL rows and misrepresent it as "0
    // delivered / dead" in the schedule panel. Collection observability comes from
    // opts.log and the event log itself.
    outcome: { whenNoSignal: 'drop' },
    enabled: () => opts.repoAllowlist.length > 0,
    actor: { role: 'repo-watcher', costTier: 'cheap' },
    display: {
      label: '仓库追评巡检',
      category: 'issue',
      description: '仓库级追评轮询：覆盖未路由 issue 的评论，灭 per-issue 盲区',
      subjectKind: 'issue',
    },
  };
}
