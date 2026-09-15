import type {
  AutomationState,
  AwaitStateV1,
  GitHubCiBaselineBucket,
  GitHubIssueWaitBaseline,
  GitHubPrWaitBaseline,
  IssueWaitAutomationState,
  PrAutomationState,
} from '@cat-cafe/shared';
import type { WaitRenewalInstruction } from '../ball-custody/wait-state-machine.js';
import type { GitHubWaitFacts } from './GitHubWaitPredicateCatalog.js';

/**
 * #1392 AC-1: the baseline generation N+1 starts from.
 *
 * Gap-free renewal means N+1 begins exactly where the observation that consumed N ended. It is
 * never a fresh GitHub read taken later: anything that arrived between the match and that read
 * would be absorbed into the baseline and never reported. So N+1 is built from the SAME
 * observation — its facts first, the collector frontier it just merged second, the previous
 * baseline last — using the field correspondence registration uses in
 * `GitHubWaitBaselineReader`, so "where tracking starts" has one definition, not two.
 */

/** Cursors are monotonic GitHub ids. A stale source must never move one backwards. */
function maxCursor(previous: number, ...observed: (number | undefined)[]): number {
  let max = previous;
  for (const value of observed) {
    if (typeof value === 'number' && Number.isFinite(value)) max = Math.max(max, value);
  }
  return max;
}

/**
 * A sentinel that no real observation can equal. After a HEAD change the previous HEAD's CI and
 * mergeability say nothing about the new one, and adopting this poll's new-HEAD values would
 * swallow them: N could not report them (every head-scoped predicate requires the HEAD it was
 * installed on), so N+1 must still be able to.
 */
const UNOBSERVED_MERGE_STATE = 'UNKNOWN';
const unobservedCiFingerprint = (headSha: string) => `${headSha}:unobserved`;

export function renewPrWaitBaseline(
  previous: GitHubPrWaitBaseline,
  collector: Pick<PrAutomationState, 'review' | 'ci' | 'conflict'>,
  facts: GitHubWaitFacts,
  at: number,
): GitHubPrWaitBaseline {
  const headSha = facts.headSha ?? collector.ci?.headSha ?? previous.headSha;
  const headChanged = headSha !== previous.headSha;

  // Review ids are not head-scoped, so they advance across a push. A late review of the old HEAD is
  // absorbed rather than reported — it is not an approval of the new HEAD — while a review OF the
  // new HEAD in this poll was already reported by N (the matcher reads `headDecisionCursor`).
  // Thread snapshots differ: N cannot report a thread change across a push, and N+1 re-reads the
  // threads every poll, so after a push N+1 keeps the previous snapshot and reports it next poll.
  const review = previous.review
    ? {
        ...previous.review,
        inlineCommentCursor: maxCursor(previous.review.inlineCommentCursor, collector.review?.lastInlineCommentCursor),
        conversationCommentCursor: maxCursor(
          previous.review.conversationCommentCursor,
          collector.review?.lastConversationCommentCursor,
          facts.review?.resultConversationCommentCursor,
        ),
        decisionCursor: maxCursor(
          previous.review.decisionCursor,
          collector.review?.lastDecisionCursor,
          facts.review?.decisionCursor,
        ),
        ...(facts.review?.decision ? { decision: facts.review.decision } : {}),
        ...(facts.review?.threads && !headChanged ? { threads: facts.review.threads } : {}),
      }
    : undefined;

  const ci = previous.ci ? renewCi(previous.ci, collector, facts, headSha, headChanged) : undefined;
  const conflict = previous.conflict
    ? {
        mergeState: headChanged
          ? UNOBSERVED_MERGE_STATE
          : (facts.conflict?.mergeState ?? collector.conflict?.mergeState ?? previous.conflict.mergeState),
      }
    : undefined;

  return {
    ...previous,
    capturedAt: at,
    headSha,
    ...(review ? { review } : {}),
    ...(ci ? { ci } : {}),
    ...(conflict ? { conflict } : {}),
  };
}

function renewCi(
  previous: NonNullable<GitHubPrWaitBaseline['ci']>,
  collector: Pick<PrAutomationState, 'ci'>,
  facts: GitHubWaitFacts,
  headSha: string,
  headChanged: boolean,
): NonNullable<GitHubPrWaitBaseline['ci']> {
  if (headChanged) return { bucket: 'pending', fingerprint: unobservedCiFingerprint(headSha) };
  if (facts.ci) return { bucket: facts.ci.bucket, fingerprint: facts.ci.fingerprint };
  if (collector.ci?.lastFingerprint && collector.ci.lastBucket) {
    return { bucket: collector.ci.lastBucket as GitHubCiBaselineBucket, fingerprint: collector.ci.lastFingerprint };
  }
  return previous;
}

export function renewIssueWaitBaseline(
  previous: GitHubIssueWaitBaseline,
  collector: Pick<IssueWaitAutomationState, 'issue'>,
  facts: GitHubWaitFacts,
  at: number,
): GitHubIssueWaitBaseline {
  const seen = (facts.issue?.comments ?? []).map((comment) => comment.id);
  return {
    capturedAt: at,
    issue: {
      ...previous.issue,
      lastCommentCursor: maxCursor(previous.issue.lastCommentCursor, collector.issue?.lastCommentCursor, ...seen),
    },
  };
}

/**
 * #1392 AC-1: the instruction for the generation after a match, built from THIS observation. It
 * carries the registered continuation, because the lifecycle may override `then` for a single
 * delivery and N+1 must not inherit that. If the baseline cannot be built, the event is still
 * delivered and the outcome says tracking was not rearmed — it never claims a wait that does not
 * exist.
 */
export function planWaitRenewal(
  active: AwaitStateV1,
  collector: AutomationState,
  facts: GitHubWaitFacts,
  at: number,
  onFailure: (error: unknown) => void,
): WaitRenewalInstruction {
  try {
    const baseline =
      'headSha' in active.baseline
        ? renewPrWaitBaseline(active.baseline, collector as PrAutomationState, facts, at)
        : renewIssueWaitBaseline(active.baseline, collector as IssueWaitAutomationState, facts, at);
    return { kind: 'renew', baseline, continuation: active.continuation };
  } catch (error) {
    onFailure(error);
    return { kind: 'rearm_failed' };
  }
}
