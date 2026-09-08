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
  resolveKnownBotAuthor,
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
    self: input.self === true,
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
    self: input.self === true,
    ...(input.knownBots ? { knownBots: input.knownBots } : {}),
  });
  // A formal verdict is authoritative no matter who it name-drops. "agree with @codex;
  // requesting changes" is a maintainer's CHANGES_REQUESTED, and typing it as bot chatter hid it
  // from every non-author tracker — they have `bot_interaction` off by default, so an
  // authoritative decision disappeared silently. A26 puts that strictly below extra noise.
  //
  // Mentioning still names a COMMENTED review as bot conversation: that is the muting affordance
  // for a bot round, and a COMMENTED submission carries no verdict to lose. What decides a
  // formal decision is AUTHORSHIP — the bot wrote it — plus a real round transition.
  const decisionState =
    input.state === 'APPROVED' || input.state === 'CHANGES_REQUESTED' || input.state === 'DISMISSED';
  const partOfBotConversation =
    botTurn !== undefined || (!decisionState && resolveMentionedKnownBot(input.body, input.knownBots) !== null);
  // #1392 defines review_decision as approve / request changes / dismiss. A submission with
  // state COMMENTED carries no verdict — it is prose plus inline findings, which is what the
  // comment surfaces are for. Labelling it a decision here made a bot's ordinary review read
  // as a maintainer verdict, and it is the shape codex itself uses to post findings.
  //
  // Only the TYPE moves. `source` stays 'pr_review' because "what have I already seen" is a
  // per-source frontier question: a review record must advance the review cursor whichever
  // surface its audience is decided on.
  const plainComment = !partOfBotConversation && input.state === 'COMMENTED';
  return {
    type: partOfBotConversation
      ? 'pr_bot_interaction'
      : plainComment
        ? 'pr_conversation_comment_added'
        : 'pr_review_decision_changed',
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
 * An explicit `authorLogins` allowlist carried by a PERSISTED predicate, lower-cased once.
 *
 * #1394 stopped ASKING a caller for its audience, but it did not delete the field: a wait
 * registered under the old surface is still on disk with `authorLogins` on it, and the type
 * still declares it. Routing those kinds to this matcher without reading the field turned a
 * two-name allowlist into "every author on the PR" — the widening is invisible from the
 * outside, because the state still says allowlist while the code no longer honours it.
 * Two matchers over one predicate type must not disagree about what its fields mean.
 */
function predicateAllowlist(predicate: GitHubWaitPredicate): ReadonlySet<string> | undefined {
  const logins = 'authorLogins' in predicate ? predicate.authorLogins : undefined;
  return logins && logins.length > 0 ? new Set(logins.map((login) => login.toLowerCase())) : undefined;
}

/**
 * The single place that decides whether an event may wake this tracker.
 *
 * Role is derived, never passed in by the caller: letting a caller name its own audience is the
 * defect #1392 exists to remove. An unresolved role falls back to ON — A26 is explicit that
 * muting a real signal is worse than one extra notification.
 *
 * An allowlist that IS on the state replaces the role default rather than stacking with it.
 * Stacking is the silent-mute direction: a non-author tracker that allowlisted a maintainer
 * would keep the allowlist, fail the "only the PR author" role branch, and deliver nothing at
 * all — worse than the widening this fixes. Self-echo suppression still applies first; nothing
 * a caller wrote may wake the cat with its own comment.
 */
function passesAudience(
  event: GitHubTrackingEvent,
  allowlist: ReadonlySet<string> | undefined,
  audience?: GitHubTrackingAudience,
): boolean {
  if (event.self) return false;
  if (audience?.selfLogin && sameLogin(event.author, audience.selfLogin)) return false;
  if (allowlist) return event.author !== undefined && allowlist.has(event.author.toLowerCase());
  if (!AUDIENCE_SCOPED_TYPES.has(event.type)) return true;
  const { selfLogin, prAuthorLogin } = audience ?? {};
  if (!selfLogin || !prAuthorLogin) return true;
  if (sameLogin(selfLogin, prAuthorLogin)) return true;
  return sameLogin(event.author, prAuthorLogin);
}

/**
 * A verdict belongs to the diff it was written about — so SAY so, do not hide it.
 *
 * codex R29 asked for stale-commit feedback to be dropped from delivery. The defect it names is
 * real: an old `CHANGES_REQUESTED` surfacing after a force-push reads as a verdict on code the
 * reviewer never saw. The remedy is not. A reviewer's comments are written against the commit
 * that existed when they read it, and HEAD routinely moves between that moment and our next
 * poll — muting on that basis would discard ordinary review feedback, which is the exact
 * silent-mute class A26 ranks above every kind of noise. F280 2.4 says it outright: current
 * HEAD never decides who gets woken.
 *
 * `replayBotTurns` does refuse a stale-commit answer, and that is not a contradiction: it is
 * answering "may this END my pending round" — state — while this is answering "does the owner
 * hear about it" — delivery. Same artifact, two questions, deliberately opposite defaults,
 * because each one avoids the loss that matters on its own side.
 *
 * So the artifact is delivered and labelled. `commitBearing` bounds it to what GitHub always
 * attaches a commit to, and an unknown commit is never labelled stale — we would be guessing.
 */
function staleCommitNote(event: GitHubTrackingEvent, observedHead: string | undefined): string {
  if (!observedHead || !event.commitBearing) return '';
  if (event.commitId === undefined || event.commitId === observedHead) return '';
  return ` (written against ${event.commitId.slice(0, 7)}; HEAD is now ${observedHead.slice(0, 7)})`;
}

export function matchGitHubTrackingEvents(
  when: readonly GitHubWaitPredicate[],
  baseline: GitHubWaitBaseline,
  events: readonly GitHubTrackingEvent[],
  options?: GitHubTrackingClockOptions,
): readonly GitHubWaitMatchedDelta[] {
  // One entry per SUBSCRIBED kind, holding that kind's audience allowlists. A `when` may name a
  // kind more than once; the union is the subscription, exactly as the typed catalog reads it.
  const subscribed = new Map<string, (ReadonlySet<string> | undefined)[]>();
  for (const predicate of when) {
    const allowlists = subscribed.get(predicate.kind);
    if (allowlists) allowlists.push(predicateAllowlist(predicate));
    else subscribed.set(predicate.kind, [predicateAllowlist(predicate)]);
  }
  const head = 'headSha' in baseline ? observedHeadSha(baseline.headSha, events) : undefined;
  const matches = events.flatMap((event) => {
    const allowlists = subscribed.get(event.type);
    if (!allowlists) return [];
    // `pr_base_behind` means the BASE moved relative to the same PR head. A replacement
    // head may itself be based on an older base; retaining that fact in the renewed
    // baseline is correct, but announcing it as "base branch advanced" is not.
    if (event.type === 'pr_base_behind' && 'headSha' in baseline && head !== baseline.headSha) return [];
    if (!isAfterFrontier(event.id, sourceFrontier(baseline, event.source))) return [];
    if (!allowlists.some((allowlist) => passesAudience(event, allowlist, options?.audience))) return [];
    return [
      {
        kind: event.type,
        delta: `${event.summary}${staleCommitNote(event, head)}`,
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
  const normalizedBody = normalizeExternalResponseBody(input.body, resolveKnownBotAuthor(input.author) !== null);
  const body = normalizedBody.trim().length > 0 ? normalizedBody : '(no text)';
  const quotedBody = body
    .split('\n')
    .map((line) => (line ? `> ${line}` : '>'))
    .join('\n');
  return `${input.surface} #${input.id} by ${input.author} — [UNTRUSTED EXTERNAL CONTENT]\n${quotedBody}`;
}

const GITHUB_MARKDOWN_BLOCK_BREAK =
  /<\s*(?:br\s*\/?|\/(?:blockquote|details|div|h[1-6]|li|ol|p|pre|summary|table|tbody|td|th|thead|tr|ul))\s*>/gi;
const GITHUB_MARKDOWN_HTML_TAG =
  /<\/?(?:a|abbr|b|blockquote|br|code|dd|del|details|div|dl|dt|em|figcaption|figure|h[1-6]|hr|i|iframe|img|kbd|li|mark|ol|p|pre|s|script|span|strong|style|sub|summary|sup|svg|table|tbody|td|th|thead|tr|ul)\b[^>]*>/gi;
const GITHUB_DETAILS_BLOCK = /<details\b[^>]*>[\s\S]*?<\/details\s*>/gi;
const CODEX_GITHUB_HELP_SUMMARY = /<summary\b[^>]*>[\s\S]*?About\s+Codex\s+in\s+GitHub[\s\S]*?<\/summary\s*>/i;
const MARKDOWN_FENCE = /^[ \t]{0,3}(`{3,}|~{3,})/;
const MAX_EXTERNAL_RESPONSE_SOURCE_CHARS = 8_192;

/**
 * GitHub returns comment bodies as source Markdown. That source is safe to persist, but it is
 * not a ready-made chat fragment: raw HTML controls render literally and flattening Markdown
 * destroys both lists and the trust boundary. Keep meaningful content up to a generous explicit
 * bound, remove the Codex connector's known help disclosure only for a known bot identity, and
 * strip presentation-only HTML while retaining its text. Code examples stay byte-for-byte intact.
 * The caller quotes every resulting line so external Markdown cannot impersonate the surrounding
 * wait outcome fields.
 */
function normalizeExternalResponseBody(source: string, stripCodexHelp: boolean): string {
  let end = Math.min(source.length, MAX_EXTERNAL_RESPONSE_SOURCE_CHARS);
  if (end < source.length && /[\uD800-\uDBFF]/.test(source[end - 1] ?? '')) end -= 1;
  const omittedCharacters = source.length - end;
  const normalized = source.slice(0, end).replace(/\r\n?/g, '\n');
  const cleaned = transformOutsideFencedCode(normalized, (markdown) =>
    transformOutsideInlineCode(markdown, (prose) =>
      prose
        .replace(/<!--[\s\S]*?-->/g, '')
        .replace(GITHUB_DETAILS_BLOCK, (block) =>
          stripCodexHelp && CODEX_GITHUB_HELP_SUMMARY.test(block) ? '' : block,
        )
        .replace(GITHUB_MARKDOWN_BLOCK_BREAK, '\n')
        .replace(GITHUB_MARKDOWN_HTML_TAG, ''),
    ),
  );

  const meaningful = cleaned.replace(/^(?:[ \t]*\n)+/, '').replace(/(?:\n[ \t]*)+$/, '');
  if (omittedCharacters === 0) return meaningful;

  const closingFence = closingFenceForTruncatedMarkdown(meaningful);
  const marker = `… [truncated ${omittedCharacters} characters from original GitHub body]`;
  return meaningful ? `${meaningful}${closingFence}\n\n${marker}` : marker;
}

function closingFenceForTruncatedMarkdown(markdown: string): string {
  let fence: { character: string; length: number } | undefined;
  for (const line of markdown.split('\n')) {
    if (!fence) {
      const opening = line.match(MARKDOWN_FENCE)?.[1];
      if (opening) fence = { character: opening[0], length: opening.length };
      continue;
    }

    const closing = line.match(/^[ \t]{0,3}(`+|~+)[ \t]*$/)?.[1];
    if (closing?.startsWith(fence.character) && closing.length >= fence.length) fence = undefined;
  }
  return fence ? `\n${fence.character.repeat(fence.length)}` : '';
}

function transformOutsideFencedCode(source: string, transform: (markdown: string) => string): string {
  const output: string[] = [];
  let prose: string[] = [];
  let fence: { character: string; length: number } | undefined;

  const flushProse = () => {
    if (prose.length === 0) return;
    output.push(transform(prose.join('\n')));
    prose = [];
  };

  for (const line of source.split('\n')) {
    if (fence) {
      output.push(line);
      const marker = line.match(/^[ \t]{0,3}(`+|~+)[ \t]*$/)?.[1];
      if (marker?.startsWith(fence.character) && marker.length >= fence.length) {
        fence = undefined;
      }
      continue;
    }

    const opening = line.match(MARKDOWN_FENCE)?.[1];
    if (!opening) {
      prose.push(line);
      continue;
    }

    flushProse();
    output.push(line);
    fence = { character: opening[0], length: opening.length };
  }

  flushProse();
  return output.join('\n');
}

function transformOutsideInlineCode(source: string, transform: (markdown: string) => string): string {
  let sentinel = '\0';
  while (source.includes(sentinel)) sentinel += '\0';

  const codeSpans: string[] = [];
  const masked = source.replace(/(`+)[\s\S]*?\1/g, (code) => {
    const index = codeSpans.push(code) - 1;
    return `${sentinel}${index}${sentinel}`;
  });
  let transformed = transform(masked);
  for (const [index, code] of codeSpans.entries()) {
    transformed = transformed.replace(`${sentinel}${index}${sentinel}`, () => code);
  }
  return transformed;
}
