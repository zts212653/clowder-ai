import type {
  GitHubPrWaitBaseline,
  GitHubWaitBaseline,
  GitHubWaitMatchedDelta,
  GitHubWaitPredicate,
  GitHubWaitPredicateKind,
} from '@cat-cafe/shared';
import {
  BOT_TURN_TIMEOUT_MS,
  classifyBotTurnTransition,
  expiredBotTurns,
  foldBotTurns,
  type GitHubBotTurnTransition,
  type KnownBot,
  resolveMentionedKnownBot,
} from './GitHubBotTurn.js';

export type GitHubTrackingSource =
  | 'pr_head'
  | 'pr_review'
  | 'pr_conversation_comment'
  | 'pr_inline_comment'
  | 'pr_ci'
  | 'pr_conflict'
  | 'pr_base'
  | 'issue_comment';

export interface GitHubTrackingEvent {
  readonly type: GitHubWaitPredicateKind;
  readonly source: GitHubTrackingSource;
  readonly id: number | string;
  readonly author?: string;
  readonly summary: string;
  readonly sourceRef?: string;
  /**
   * Identity verdict, produced ONCE where the fact is produced (F280 section 8.3) and read
   * by exactly one row of the chain. Self-authored events still travel the stream: they
   * advance frontiers and open bot turns, they just never wake their own author.
   */
  readonly self?: boolean;
  /** The GitHub review this artifact belongs to — an inline finding is part of a review. */
  readonly reviewId?: number;
  /** The commit this artifact is about, when GitHub gives us one. */
  readonly commitId?: string;
  /** True for review artifacts, whose commit must be established before they can end a round. */
  readonly commitBearing?: boolean;
  readonly botTurn?: GitHubBotTurnTransition;
}

export const GITHUB_TRACKING_EVENT_KINDS = new Set<GitHubWaitPredicateKind>([
  'pr_head_changed',
  'pr_review_decision_changed',
  'pr_conversation_comment_added',
  'pr_inline_comment_added',
  'pr_bot_interaction',
  'pr_ci_terminal',
  'pr_became_conflicting',
  'pr_base_behind',
  'issue_comment_added',
]);

function epochMs(timestamp: string | undefined, fallback: number): number {
  const parsed = timestamp ? Date.parse(timestamp) : Number.NaN;
  return Number.isFinite(parsed) ? parsed : fallback;
}

export interface NormalizePrCommentInput {
  readonly id: number;
  readonly author: string;
  readonly body: string;
  readonly createdAt?: string;
  readonly commentType: 'inline' | 'conversation';
  readonly reviewId?: number;
  readonly commitId?: string;
  readonly self?: boolean;
  readonly knownBots?: readonly KnownBot[];
}

/**
 * The one place a PR comment becomes a tracking event. Both halves of a bot turn get the
 * `pr_bot_interaction` NAME instead of their surface name — one vocabulary, one axis — while
 * `source` keeps the surface so each frontier still advances on its own lane.
 */
export function normalizePrCommentEvent(input: NormalizePrCommentInput): GitHubTrackingEvent {
  const inline = input.commentType === 'inline';
  const botTurn = classifyBotTurnTransition({
    author: input.author,
    body: input.body,
    at: epochMs(input.createdAt, input.id),
    ...(input.knownBots ? { knownBots: input.knownBots } : {}),
  });
  // Naming and round state are different questions over the same identity table. Mentioning a
  // bot makes the comment part of the bot conversation (so a maintainer can mute it); only a
  // command opens a round, because only a command can go unanswered.
  const partOfBotConversation = botTurn !== undefined || resolveMentionedKnownBot(input.body, input.knownBots) !== null;
  return {
    type: partOfBotConversation
      ? 'pr_bot_interaction'
      : inline
        ? 'pr_inline_comment_added'
        : 'pr_conversation_comment_added',
    source: inline ? 'pr_inline_comment' : 'pr_conversation_comment',
    id: input.id,
    author: input.author,
    summary: externalResponseSummary({
      surface: inline ? 'inline comment' : 'conversation comment',
      id: input.id,
      author: input.author,
      body: input.body,
    }),
    sourceRef: `github:pr-${input.commentType}-comment:${input.id}`,
    ...(input.reviewId ? { reviewId: input.reviewId } : {}),
    ...(input.commitId ? { commitId: input.commitId } : {}),
    ...(inline ? { commitBearing: true } : {}),
    ...(input.self ? { self: true } : {}),
    ...(botTurn ? { botTurn } : {}),
  };
}

export interface NormalizePrReviewInput {
  readonly id: number;
  readonly author: string;
  readonly state: string;
  readonly body: string;
  readonly submittedAt?: string;
  readonly commitId?: string;
  readonly self?: boolean;
  readonly knownBots?: readonly KnownBot[];
}

export function normalizePrReviewEvent(input: NormalizePrReviewInput): GitHubTrackingEvent {
  const botTurn = classifyBotTurnTransition({
    author: input.author,
    body: input.body,
    at: epochMs(input.submittedAt, input.id),
    ...(input.knownBots ? { knownBots: input.knownBots } : {}),
  });
  const partOfBotConversation = botTurn !== undefined || resolveMentionedKnownBot(input.body, input.knownBots) !== null;
  return {
    type: partOfBotConversation ? 'pr_bot_interaction' : 'pr_review_decision_changed',
    source: 'pr_review',
    id: input.id,
    author: input.author,
    summary: externalResponseSummary({
      surface: `formal review ${input.state}`,
      id: input.id,
      author: input.author,
      body: input.body,
    }),
    sourceRef: `github:pr-review:${input.id}`,
    ...(input.commitId ? { commitId: input.commitId } : {}),
    commitBearing: true,
    ...(input.self ? { self: true } : {}),
    ...(botTurn ? { botTurn } : {}),
  };
}

export interface PrBatchComment {
  readonly id: number;
  readonly author: string;
  readonly body: string;
  readonly createdAt: string;
  readonly commentType: 'inline' | 'conversation';
  readonly reviewId?: number;
  readonly commitId?: string;
}

export interface PrBatchReview {
  readonly id: number;
  readonly author: string;
  readonly state: string;
  readonly body: string;
  readonly submittedAt: string;
  readonly commitId?: string;
}

export interface PrFeedbackBatchInput<C extends PrBatchComment, D extends PrBatchReview> {
  readonly headSha: string;
  readonly comments: readonly C[];
  readonly decisions: readonly D[];
  readonly isSelfComment?: (comment: C) => boolean;
  readonly isSelfReview?: (review: D) => boolean;
  readonly knownBots?: readonly KnownBot[];
}

/**
 * ONE construction of the normalized batch, shared by everything that needs to know what this
 * poll actually contained.
 *
 * The cloud-review aggregate used to read the round state as it stood BEFORE this batch was
 * folded, which made it structurally blind to anything that both opened and closed inside one
 * poll — the ordinary fast path, since a bot can answer well inside a 60s interval. Patching
 * that with a second reader in the collector would have been a second normalizer, which is the
 * shape F280 section 3.1 blames for five bugs. Both consumers take this batch instead.
 */
export function normalizePrFeedbackBatch<C extends PrBatchComment, D extends PrBatchReview>(
  input: PrFeedbackBatchInput<C, D>,
): GitHubTrackingEvent[] {
  // An inline finding sometimes reaches us without its own commit. It is NOT resolved from its
  // review here, deliberately: `commitBearing` already stops an artifact of unestablished commit
  // from ending a round, and when the review IS present and current it closes the round itself.
  // Resolving as well changed no outcome in any scenario — an unfalsifiable mechanism is not a
  // safeguard, it is something the next reader has to disprove.
  return [
    {
      type: 'pr_head_changed',
      source: 'pr_head',
      id: input.headSha,
      summary: `HEAD changed to ${input.headSha.slice(0, 7)}`,
    },
    ...input.comments.map((comment) =>
      normalizePrCommentEvent({
        id: comment.id,
        author: comment.author,
        body: comment.body,
        createdAt: comment.createdAt,
        commentType: comment.commentType,
        ...(comment.reviewId ? { reviewId: comment.reviewId } : {}),
        ...(comment.commitId ? { commitId: comment.commitId } : {}),
        self: input.isSelfComment?.(comment) ?? false,
        ...(input.knownBots ? { knownBots: input.knownBots } : {}),
      }),
    ),
    ...input.decisions.map((review) =>
      normalizePrReviewEvent({
        id: review.id,
        author: review.author,
        state: review.state,
        body: review.body,
        submittedAt: review.submittedAt,
        ...(review.commitId ? { commitId: review.commitId } : {}),
        self: input.isSelfReview?.(review) ?? false,
        ...(input.knownBots ? { knownBots: input.knownBots } : {}),
      }),
    ),
  ];
}

const SOURCE_FRONTIERS: Record<GitHubTrackingSource, (baseline: GitHubWaitBaseline) => number | string | null> = {
  pr_head: (baseline) => ('headSha' in baseline ? baseline.headSha : null),
  pr_review: (baseline) => ('headSha' in baseline ? (baseline.review?.decisionCursor ?? null) : null),
  pr_conversation_comment: (baseline) =>
    'headSha' in baseline ? (baseline.review?.conversationCommentCursor ?? null) : null,
  pr_inline_comment: (baseline) => ('headSha' in baseline ? (baseline.review?.inlineCommentCursor ?? null) : null),
  pr_ci: (baseline) => ('headSha' in baseline ? (baseline.ci?.fingerprint ?? null) : null),
  pr_conflict: (baseline) => ('headSha' in baseline ? (baseline.conflict?.mergeState ?? null) : null),
  pr_base: (baseline) => ('headSha' in baseline && baseline.base ? String(baseline.base.isBehind) : null),
  issue_comment: (baseline) => ('issue' in baseline ? baseline.issue.lastCommentCursor : null),
};

function sourceFrontier(baseline: GitHubWaitBaseline, source: GitHubTrackingSource): number | string | null {
  return SOURCE_FRONTIERS[source](baseline);
}

function isAfterFrontier(id: number | string, frontier: number | string | null): boolean {
  if (frontier === null || typeof id !== typeof frontier) return false;
  return typeof id === 'number' ? id > (frontier as number) : id !== frontier;
}

export interface GitHubTrackingClockOptions {
  readonly now?: number;
  readonly botTurnTimeoutMs?: number;
  readonly audience?: GitHubTrackingAudience;
}

/**
 * F280 section 2.4b / A30. Who this tracker is, so the chain can answer "whose words do I
 * want" — not just "is this mine".
 *
 * Expressing the role difference as a subscription default could only ever say "mute the bot
 * round"; a maintainer stayed subscribed to conversation_comment and therefore heard every
 * third party. The role has to reach the filter itself.
 */
export interface GitHubTrackingAudience {
  /** The tracking owner's GitHub login. */
  readonly selfLogin?: string;
  /** The PR author's login. Absent for issues, or when it could not be resolved. */
  readonly prAuthorLogin?: string;
}

/** Comment surfaces are audience-scoped; a formal review decision is PR state and is not. */
const AUDIENCE_SCOPED_TYPES: ReadonlySet<string> = new Set([
  'pr_conversation_comment_added',
  'pr_inline_comment_added',
]);

const sameLogin = (a?: string, b?: string): boolean =>
  a !== undefined && b !== undefined && a.toLowerCase() === b.toLowerCase();

/**
 * The single place that decides whether an event may wake this tracker.
 *
 * Role is derived, never passed in by the caller: letting a caller name its own audience is the
 * defect #1392 exists to remove. An unresolved role falls back to ON — A26 is explicit that
 * muting a real signal is worse than one extra notification.
 */
function passesAudience(event: GitHubTrackingEvent, audience?: GitHubTrackingAudience): boolean {
  if (event.self) return false;
  if (audience?.selfLogin && sameLogin(event.author, audience.selfLogin)) return false;
  if (!AUDIENCE_SCOPED_TYPES.has(event.type)) return true;
  const { selfLogin, prAuthorLogin } = audience ?? {};
  if (!selfLogin || !prAuthorLogin) return true;
  if (sameLogin(selfLogin, prAuthorLogin)) return true;
  return sameLogin(event.author, prAuthorLogin);
}

export function matchGitHubTrackingEvents(
  when: readonly GitHubWaitPredicate[],
  baseline: GitHubWaitBaseline,
  events: readonly GitHubTrackingEvent[],
  options?: GitHubTrackingClockOptions,
): readonly GitHubWaitMatchedDelta[] {
  const subscribed = new Set(when.map((predicate) => predicate.kind));
  const matches = events.flatMap((event) => {
    if (!subscribed.has(event.type)) return [];
    if (!isAfterFrontier(event.id, sourceFrontier(baseline, event.source))) return [];
    if (!passesAudience(event, options?.audience)) return [];
    return [
      {
        kind: event.type,
        delta: event.summary,
        ...(event.sourceRef ? { sourceRef: event.sourceRef } : {}),
      },
    ];
  });
  if (!subscribed.has('pr_bot_interaction') || !('headSha' in baseline)) return matches;
  // A28: a turn that opened and never closed is the "clicked review, heard nothing" case.
  // It is derived from the SAME state the stream advances, so it can fire exactly once.
  const stillOpen = foldBotTurns(baseline.botTurns, events, observedHeadSha(baseline.headSha, events));
  const timedOut = expiredBotTurns(stillOpen, options).map((turn) => ({
    kind: 'pr_bot_interaction' as const,
    delta: `@${turn.bot} never answered the request in comment #${turn.triggerId} — no response after ${Math.round(
      (options?.botTurnTimeoutMs ?? BOT_TURN_TIMEOUT_MS) / 60_000,
    )}m`,
    sourceRef: `github:pr-bot-turn:${turn.bot}:${turn.triggerId}`,
  }));
  return [...matches, ...timedOut];
}

/** The HEAD this batch describes: the newest `pr_head` in it, else the frontier we came in with. */
function observedHeadSha(baselineHeadSha: string, events: readonly GitHubTrackingEvent[]): string {
  return latestStringFrontier(events, 'pr_head', baselineHeadSha);
}

function maxNumberFrontier(
  events: readonly GitHubTrackingEvent[],
  source: GitHubTrackingSource,
  current: number,
): number {
  return events.reduce(
    (max, event) => (event.source === source && typeof event.id === 'number' ? Math.max(max, event.id) : max),
    current,
  );
}

function latestStringFrontier(
  events: readonly GitHubTrackingEvent[],
  source: GitHubTrackingSource,
  current: string,
): string {
  return events.reduce(
    (latest, event) => (event.source === source && typeof event.id === 'string' ? event.id : latest),
    current,
  );
}

function advancePrBaseline(
  baseline: GitHubPrWaitBaseline,
  events: readonly GitHubTrackingEvent[],
  options?: GitHubTrackingClockOptions,
): GitHubPrWaitBaseline {
  const review = {
    ...baseline.review,
    inlineCommentCursor: maxNumberFrontier(events, 'pr_inline_comment', baseline.review?.inlineCommentCursor ?? 0),
    conversationCommentCursor: maxNumberFrontier(
      events,
      'pr_conversation_comment',
      baseline.review?.conversationCommentCursor ?? 0,
    ),
    decisionCursor: maxNumberFrontier(events, 'pr_review', baseline.review?.decisionCursor ?? 0),
  };
  // The batch's own HEAD, not the frontier we are about to replace: a batch that carries both a
  // push and a summon on the pushed commit would otherwise bind the round to the commit it was
  // NOT asked about, and F168 would then discard a live round as belonging to an older diff.
  const headSha = observedHeadSha(baseline.headSha, events);
  const ciFingerprint = latestStringFrontier(events, 'pr_ci', baseline.ci?.fingerprint ?? '');
  const conflictState = latestStringFrontier(events, 'pr_conflict', baseline.conflict?.mergeState ?? '');
  const baseState = latestStringFrontier(events, 'pr_base', baseline.base ? String(baseline.base.isBehind) : '');
  // A28/A29: opening, closing and expiring a turn happen on the same pass that advances every
  // other frontier, so a turn can never be reported without also being retired.
  const openTurns = foldBotTurns(baseline.botTurns, events, headSha);
  for (const expired of expiredBotTurns(openTurns, options)) delete openTurns[expired.bot];
  const { botTurns: _retired, ...withoutTurns } = baseline;
  return {
    ...withoutTurns,
    headSha,
    review,
    ...(baseline.ci && ciFingerprint ? { ci: { ...baseline.ci, fingerprint: ciFingerprint } } : {}),
    ...(conflictState ? { conflict: { mergeState: conflictState } } : {}),
    ...(baseState ? { base: { isBehind: baseState === 'true' } } : {}),
    ...(Object.keys(openTurns).length > 0 ? { botTurns: openTurns } : {}),
  };
}

export function advanceGitHubTrackingBaseline(
  baseline: GitHubWaitBaseline,
  events: readonly GitHubTrackingEvent[],
  options?: GitHubTrackingClockOptions,
): GitHubWaitBaseline {
  if ('headSha' in baseline) return advancePrBaseline(baseline, events, options);
  return {
    ...baseline,
    issue: {
      ...baseline.issue,
      lastCommentCursor: maxNumberFrontier(events, 'issue_comment', baseline.issue.lastCommentCursor),
    },
  };
}

export function externalResponseSummary(input: {
  readonly surface: string;
  readonly id: number;
  readonly author: string;
  readonly body: string;
}): string {
  const body =
    input.body
      .replace(/[\r\n\t ]+/g, ' ')
      .trim()
      .slice(0, 500) || '(no text)';
  return `${input.surface} #${input.id} by ${input.author} — [UNTRUSTED EXTERNAL CONTENT] ${body}`;
}
