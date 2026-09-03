import type { GitHubBotTurn } from '@cat-cafe/shared';
import type { PrFeedbackComment, PrReviewDecision } from '../../infrastructure/email/ReviewFeedbackRouter.js';
import {
  type BotTurnClosure,
  expiredBotTurns,
  KNOWN_BOTS,
  type KnownBot,
  replayBotTurns,
  resolveKnownBotAuthor,
} from './GitHubBotTurn.js';
import type { GitHubTrackingEvent } from './GitHubTrackingEvent.js';

/**
 * F168 cloud-review status, derived from the SAME normalized facts that drive bot rounds.
 *
 * This used to be produced by `external-cloud-review-classifier`, which only ran when the
 * caller had registered a `pr_review_result_available` predicate by hand. F280 removed that
 * public predicate — and the aggregate lost its only producer, so a repo configured with
 * `cloudReviewPolicy=required` would sit at `cloud_review_required` forever. The name is gone
 * for good; the fact it carried is not, so it is re-derived here from bot identity and round
 * state rather than from anything the caller has to name.
 */
export type CloudReviewStatus = 'running' | 'clean' | 'blocking' | 'failed_or_timeout';

export interface CloudReviewObservationInput {
  readonly headSha: string;
  readonly comments: readonly PrFeedbackComment[];
  readonly decisions: readonly PrReviewDecision[];
  /** Round state as it stood BEFORE this batch. */
  readonly openTurns?: Readonly<Record<string, GitHubBotTurn>>;
  /**
   * This poll's normalized batch. Without it the aggregate can only see rounds that survived a
   * previous poll, which makes a summon answered inside one interval — the ordinary fast path —
   * structurally invisible: it opens and closes between two readings and leaves no state behind.
   */
  readonly events?: readonly GitHubTrackingEvent[];
  readonly knownBots?: readonly KnownBot[];
  /** Present on a live poll; lets an unanswered round reach `failed_or_timeout`. */
  readonly now?: number;
  readonly botTurnTimeoutMs?: number;
}

export interface DerivedCloudReviewObservation {
  readonly status: CloudReviewStatus;
  readonly triggerCommentId?: number;
  readonly reviewId?: number;
}

/**
 * A cloud verdict is about a DIFF, so every fact here is scoped to the current HEAD.
 *
 * An earlier version accepted `headSha` and never read it, which meant: a review of an old
 * commit was reported as a verdict on code the bot never saw, a round opened against an old
 * HEAD read as "still running" on the new one, and any bot conversation comment — including
 * "Codex could not review this pull request." — was reported as `clean`.
 *
 * Returns null when this poll says nothing about the current HEAD. Silence is not an
 * observation, and reporting `running` for a PR nobody asked about would strand the aggregate.
 */
export function deriveCloudReviewObservation(input: CloudReviewObservationInput): DerivedCloudReviewObservation | null {
  const known = input.knownBots ?? KNOWN_BOTS;
  const events = input.events ?? [];

  // Replay the batch in time order. An answer can only close a round that was open BEFORE it —
  // collecting "every round this batch touched" and then attributing any answer to that set
  // reported bot chatter at 09:29 as the failure of a round opened at 09:30.
  const replay = replayBotTurns(input.openTurns, events, input.headSha);
  const stillOpen = onCurrentHead(replay.state, input.headSha);
  const closures = replay.closures.filter((closure) => closure.round.headSha === input.headSha);

  // F168 holds ONE current status, so the batch has to reduce to the state of the round that was
  // decided LAST — not to a fixed "review beats clean beats unreadable" priority. That priority
  // reported an older round's clean verdict while the batch ended in a new round failing, which
  // marks a PR ready on a verdict that has since been superseded; and it reported an older
  // failure while a new round was already running, which the aggregate's own downgrade guard
  // then pins in place because `running` may not overwrite a terminal.
  const decided = [
    ...closures.map((closure) => ({ at: closure.by.at, resolve: () => classifyClosure(closure, input, known) })),
    ...Object.entries(stillOpen).map(([, round]) => ({
      at: round.openedAt,
      resolve: () => openRoundStatus(round, input),
    })),
  ].sort((left, right) => left.at - right.at);
  const latest = decided.at(-1);
  if (latest) return latest.resolve();

  // Nothing of ours was in flight. A verdict that carries its own commit evidence still counts —
  // tracking may have started after the round did.
  return commitEvidencedVerdict(input, known);
}

/** What did THIS answer say? Read from the item that actually closed the round. */
function classifyClosure(
  closure: BotTurnClosure,
  input: CloudReviewObservationInput,
  known: readonly KnownBot[],
): DerivedCloudReviewObservation {
  const triggerCommentId = closure.round.triggerId;
  if (closure.by.source === 'pr_review') {
    const review = input.decisions.find((decision) => decision.id === closure.by.id);
    if (review && review.commitId === input.headSha) {
      return { ...reviewVerdict(review, input, known), triggerCommentId, reviewId: review.id };
    }
    // A review of a different commit closes the round but says nothing about this diff.
    return { status: 'failed_or_timeout', triggerCommentId };
  }
  // An inline finding and the formal review that carries it are ARTIFACTS OF ONE REVIEW. Whichever
  // of them happens to close the round, the verdict belongs to the review — reading the inline
  // comment on its own as "an answer I cannot parse" turned Codex's ordinary findings-plus-
  // CHANGES_REQUESTED into a reported failure, on the main path.
  if (closure.by.reviewId !== undefined) {
    const review = input.decisions.find((decision) => decision.id === closure.by.reviewId);
    if (review && review.commitId === input.headSha) {
      return { ...reviewVerdict(review, input, known), triggerCommentId, reviewId: review.id };
    }
    // The review itself has not arrived (or is about another commit), but a bot inline finding IS
    // a finding: blocking, never "no result".
    return { status: 'blocking', triggerCommentId, reviewId: closure.by.reviewId };
  }
  const comment = input.comments.find((candidate) => candidate.id === closure.by.id);
  if (comment && reviewedCommitOfCleanVerdict(comment.body, input.headSha)) {
    return { status: 'clean', triggerCommentId };
  }
  // The answer ended the round without a verdict we can read — reported as exactly that, with no
  // guess about which kind of non-result it is (section 2.4 forbids prose judgement).
  return { status: 'failed_or_timeout', triggerCommentId };
}

function openRoundStatus(round: GitHubBotTurn, input: CloudReviewObservationInput): DerivedCloudReviewObservation {
  const expired = expiredBotTurns(
    { round },
    {
      ...(input.now === undefined ? {} : { now: input.now }),
      ...(input.botTurnTimeoutMs === undefined ? {} : { botTurnTimeoutMs: input.botTurnTimeoutMs }),
    },
  );
  return { status: expired.length > 0 ? 'failed_or_timeout' : 'running', triggerCommentId: round.triggerId };
}

function reviewVerdict(
  review: CloudReviewObservationInput['decisions'][number],
  input: CloudReviewObservationInput,
  known: readonly KnownBot[],
): { status: CloudReviewStatus } {
  const findings = input.comments.filter(
    (comment) =>
      comment.commentType === 'inline' &&
      comment.reviewId === review.id &&
      resolveKnownBotAuthor(comment.author, known) !== null,
  );
  // DISMISSED is how the connector reports its own failure; it is not a verdict on the diff.
  if (review.state === 'DISMISSED') return { status: 'failed_or_timeout' };
  if (review.state === 'CHANGES_REQUESTED' || findings.length > 0) return { status: 'blocking' };
  return { status: 'clean' };
}

function commitEvidencedVerdict(
  input: CloudReviewObservationInput,
  known: readonly KnownBot[],
): DerivedCloudReviewObservation | null {
  const botReview = [...input.decisions]
    .filter((decision) => resolveKnownBotAuthor(decision.author, known) !== null && decision.commitId === input.headSha)
    .sort((left, right) => left.id - right.id)
    .at(-1);
  if (botReview) return { ...reviewVerdict(botReview, input, known), reviewId: botReview.id };
  const clean = input.comments.find(
    (comment) =>
      comment.commentType === 'conversation' &&
      resolveKnownBotAuthor(comment.author, known) !== null &&
      reviewedCommitOfCleanVerdict(comment.body, input.headSha),
  );
  return clean ? { status: 'clean' } : null;
}

function onCurrentHead(turns: Readonly<Record<string, GitHubBotTurn>>, headSha: string): Record<string, GitHubBotTurn> {
  // A round with no recorded HEAD fails CLOSED: "I do not know which diff this was about" must
  // not be read as "it was about the current one".
  return Object.fromEntries(Object.entries(turns).filter(([, turn]) => turn.headSha === headSha));
}

const CLEAN_VERDICT_HEAD = /^Codex Review:\s*Didn't find any major issues\./i;
const REVIEWED_COMMIT = /^\*\*Reviewed commit:\*\*\s*`([0-9a-f]{7,40})`\s*$/gim;

/** True only for the bot's canonical "nothing to fix" verdict naming the CURRENT head commit. */
function reviewedCommitOfCleanVerdict(body: string, headSha: string): boolean {
  const firstLine = body.trimStart().split(/\r?\n/, 1)[0]?.trim() ?? '';
  if (!CLEAN_VERDICT_HEAD.test(firstLine)) return false;
  const matches = [...body.matchAll(REVIEWED_COMMIT)];
  const reviewed = matches.length === 1 ? matches[0]?.[1] : undefined;
  return reviewed !== undefined && headSha.toLowerCase().startsWith(reviewed.toLowerCase());
}
