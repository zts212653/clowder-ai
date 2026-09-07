import type { GitHubBotTurn, GitHubPrWaitBaseline, PrAutomationState } from '@cat-cafe/shared';
import { resolveSummonedKnownBot } from './GitHubBotTurn.js';

interface GithubIdItem {
  readonly id?: unknown;
}

/** Conversation comments carry the text we need to recognise a bot summon at registration. */
interface GithubConversationComment extends GithubIdItem {
  readonly body?: unknown;
  readonly created_at?: unknown;
  readonly user?: { readonly login?: unknown };
}

interface GithubReviewItem extends GithubIdItem {
  readonly state?: string;
}

export interface GitHubWaitBaselineReaderDeps {
  readonly fetchCi: (
    repoFullName: string,
    prNumber: number,
  ) => Promise<{ headSha: string; aggregateBucket: string } | null>;
  readonly fetchInlineComments: (repoFullName: string, prNumber: number) => Promise<readonly GithubIdItem[]>;
  readonly fetchConversationComments: (
    repoFullName: string,
    prNumber: number,
  ) => Promise<readonly GithubConversationComment[]>;
  readonly fetchReviews: (repoFullName: string, prNumber: number) => Promise<readonly GithubReviewItem[]>;
  readonly fetchMergeState: (
    repoFullName: string,
    prNumber: number,
  ) => Promise<{ readonly mergeState: string; readonly mergeStateStatus: string }>;
  /** F280 section 2.4b: the PR's author login, used only to pick role defaults. */
  readonly fetchAuthorLogin?: (repoFullName: string, prNumber: number) => Promise<string | null>;
  /**
   * F177 / F280 A28: does this exact trigger comment have a bot that ACCEPTED the job and has
   * not answered yet? Registration uses it to open the round synchronously, so a cat that just
   * posted `@codex review` can clean-stop the same turn instead of waiting a poll cycle.
   */
  readonly verifyBotTriggerCoverage?: (input: {
    readonly repoFullName: string;
    readonly prNumber: number;
    readonly triggerCommentId: number;
  }) => Promise<{ readonly covered: boolean }>;
  readonly now?: () => number;
}

export interface InitialPrWaitSnapshot {
  readonly baseline: GitHubPrWaitBaseline;
  readonly collectorState: PrAutomationState;
  /** Absent when GitHub could not tell us; the caller then defaults toward notifying. */
  readonly authorLogin?: string;
  /**
   * Did this registration actually ASK about open bot rounds, and get an answer?
   *
   * `verified` means the probe ran to completion: whatever `baseline.botTurns` says is current
   * truth, including "no round is open". `unavailable` means we could not find out. Collapsing
   * both into an absent `botTurns` made "the round is answered" indistinguishable from "GitHub
   * was down", so a re-registration either kept a dead round or dropped a live one at random.
   */
  readonly botTurnProbe: 'verified' | 'unavailable';
}

function maxGithubId(items: readonly GithubIdItem[]): number {
  let max = 0;
  for (const item of items) {
    if (typeof item.id === 'number' && Number.isFinite(item.id)) max = Math.max(max, item.id);
  }
  return max;
}

export async function readGitHubWaitBaseline(
  input: {
    readonly repoFullName: string;
    readonly prNumber: number;
    /** F177: the authenticated invocation asking for this registration, if any. */
    readonly invocationId?: string;
    /** F177: only OUR OWN summon can grant us an exit; someone else's is not our proof. */
    readonly isSelfLogin?: (login: string) => boolean | undefined;
  },
  deps: GitHubWaitBaselineReaderDeps,
): Promise<InitialPrWaitSnapshot> {
  const ci = await deps.fetchCi(input.repoFullName, input.prNumber);
  if (!ci?.headSha) {
    throw new Error(`Current PR HEAD unavailable for ${input.repoFullName}#${input.prNumber}`);
  }

  // Registration freezes every source frontier. Conditional seeding previously
  // replayed history and made valid surfaces unmatchable after subscription changes.
  const [inlineComments, conversationComments, reviews, merge, authorLogin] = await Promise.all([
    deps.fetchInlineComments(input.repoFullName, input.prNumber),
    deps.fetchConversationComments(input.repoFullName, input.prNumber),
    deps.fetchReviews(input.repoFullName, input.prNumber),
    deps.fetchMergeState(input.repoFullName, input.prNumber),
    deps.fetchAuthorLogin?.(input.repoFullName, input.prNumber).catch(() => null) ?? Promise.resolve(null),
  ]);

  const inlineCommentCursor = maxGithubId(inlineComments);
  const conversationCommentCursor = maxGithubId(conversationComments);
  const decisionCursor = maxGithubId(reviews);
  const latestReview = [...reviews]
    .filter((review): review is GithubReviewItem & { id: number } => typeof review.id === 'number')
    .sort((a, b) => a.id - b.id)
    .at(-1);
  const ciBucket =
    ci.aggregateBucket === 'pass' || ci.aggregateBucket === 'fail' || ci.aggregateBucket === 'pending'
      ? ci.aggregateBucket
      : 'external_infrastructure';
  const capturedAt = (deps.now ?? Date.now)();
  const turnProbe = await probeOpenBotTurn(input, conversationComments, deps, ci.headSha);

  const reviewState = {
    inlineCommentCursor,
    conversationCommentCursor,
    decisionCursor,
    ...(latestReview?.state ? { decision: latestReview.state } : {}),
  };

  return {
    ...(authorLogin ? { authorLogin } : {}),
    botTurnProbe: turnProbe.probe,
    baseline: {
      capturedAt,
      headSha: ci.headSha,
      ...(authorLogin ? { prAuthorLogin: authorLogin } : {}),
      review: reviewState,
      ci: {
        bucket: ciBucket,
        fingerprint: `${ci.headSha}:${ciBucket}`,
      },
      conflict: { mergeState: merge.mergeState },
      base: { isBehind: merge.mergeStateStatus === 'BEHIND' },
      ...(turnProbe.botTurns ? { botTurns: turnProbe.botTurns } : {}),
    },
    collectorState: {
      review: {
        lastCommentCursor: Math.max(inlineCommentCursor, conversationCommentCursor),
        lastInlineCommentCursor: inlineCommentCursor,
        lastConversationCommentCursor: conversationCommentCursor,
        lastDecisionCursor: decisionCursor,
      },
      ci: {
        headSha: ci.headSha,
        lastFingerprint: `${ci.headSha}:${ciBucket}`,
        lastBucket: ciBucket,
      },
      conflict: { mergeState: merge.mergeState, mergeStateStatus: merge.mergeStateStatus },
    },
  };
}

/**
 * Registration freezes frontiers, but an OPEN round is state rather than history: the cat that
 * just summoned a bot is waiting on an answer right now, and making it wait for the first poll
 * to discover that is what broke same-turn clean stop.
 *
 * A round is seeded only when the coverage verifier confirms the bot accepted and has not
 * answered. Anything else — no summon, uncovered, verifier unavailable — seeds nothing: an
 * invented round would later report a timeout for a request nobody made, and a missing round
 * only costs the cat one held ball, which it can always release later.
 */
async function probeOpenBotTurn(
  input: {
    readonly repoFullName: string;
    readonly prNumber: number;
    readonly invocationId?: string;
    readonly isSelfLogin?: (login: string) => boolean | undefined;
  },
  conversationComments: readonly GithubConversationComment[],
  deps: GitHubWaitBaselineReaderDeps,
  headSha: string,
): Promise<{ probe: 'verified' | 'unavailable'; botTurns?: Record<string, GitHubBotTurn> }> {
  const isSelfLogin = input.isSelfLogin;
  if (!deps.verifyBotTriggerCoverage || !isSelfLogin) return { probe: 'unavailable' };
  let identityUnknown = false;
  const summons = conversationComments.flatMap((comment) => {
    if (typeof comment.id !== 'number' || typeof comment.body !== 'string') return [];
    const bot = resolveSummonedKnownBot(comment.body);
    if (!bot) return [];
    // Only OUR OWN summon grants us anything. A maintainer's `@codex review` on the same PR is a
    // real round, but it is not this cat's proof that an event is coming back to this turn.
    //
    // "I cannot tell whether this was me" is NOT "this was not me". Dropping such a summon and
    // then reporting `verified` claimed we had checked and found nothing of ours — and a later
    // re-registration deleted a live round on the strength of that claim.
    // Two ways not to know: GitHub did not give us an author (deleted/ghost user), or our own
    // identity will not resolve. They are the SAME boundary and must produce the same answer —
    // this is the third time in this function that "unknown" tried to pass as "checked".
    const author = typeof comment.user?.login === 'string' ? comment.user.login : undefined;
    const mine = author === undefined ? undefined : isSelfLogin(author);
    if (mine === undefined) {
      identityUnknown = true;
      return [];
    }
    if (!mine) return [];
    const openedAt = typeof comment.created_at === 'string' ? Date.parse(comment.created_at) : Number.NaN;
    return [{ id: comment.id, bot, openedAt: Number.isFinite(openedAt) ? openedAt : (deps.now ?? Date.now)() }];
  });
  const latest = summons.sort((left, right) => left.id - right.id).at(-1);
  if (!latest) {
    // No summon of ours is a VERIFIED answer — unless we could not resolve our own identity, in
    // which case we simply do not know.
    return { probe: identityUnknown ? 'unavailable' : 'verified' };
  }
  try {
    const coverage = await deps.verifyBotTriggerCoverage({
      repoFullName: input.repoFullName,
      prNumber: input.prNumber,
      triggerCommentId: latest.id,
    });
    // "Not covered" is also a verified answer — the bot never accepted, or already replied.
    if (!coverage.covered) return { probe: 'verified' };
  } catch {
    return { probe: 'unavailable' };
  }
  return {
    probe: 'verified',
    botTurns: {
      [latest.bot]: {
        triggerId: latest.id,
        openedAt: latest.openedAt,
        headSha,
        ...(input.invocationId ? { grantInvocationId: input.invocationId } : {}),
      },
    },
  };
}
