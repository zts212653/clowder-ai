import type { GitHubBotTurn } from '@cat-cafe/shared';

/**
 * F280 section 4b — bot interaction TURNS.
 *
 * A turn opens when a comment @-mentions a known bot and closes when that bot answers.
 * Both halves are decided from GitHub's own first-class structures — the mention list and
 * the author login — plus the bot identity list we maintain. Never from what the prose
 * looks like: "this comment seems to be a trigger" is exactly the guessing F280 section 2.4
 * forbids, because guessing wrong is silent.
 */

/**
 * One known bot = the account that ANSWERS plus the handle(s) you @ to summon it.
 *
 * These are two different strings and conflating them is not a detail: you write
 * `@codex review`, and `chatgpt-codex-connector[bot]` answers. An earlier version of this
 * module matched mentions against the answering login only, so no real trigger comment could
 * ever open a round — A28/A29 were green in tests and dead in production, because the tests
 * mentioned the answering login too. Identity data, not a heuristic; `botTurns` stays bounded
 * by this table's length.
 */
export interface KnownBot {
  /** The account that posts the answer. */
  readonly login: string;
  /** The handle(s) a human or cat @-mentions to summon it. */
  readonly triggerHandles: readonly string[];
}

export const KNOWN_BOTS: readonly KnownBot[] = [
  { login: 'chatgpt-codex-connector[bot]', triggerHandles: ['codex', 'chatgpt-codex-connector'] },
];

/** Kept for callers that only need the answering identities. */
export const KNOWN_BOT_LOGINS: readonly string[] = KNOWN_BOTS.map((bot) => bot.login);

/** A28: how long an unanswered turn may stay open before we say it never came back. */
export const BOT_TURN_TIMEOUT_MS = 30 * 60_000;

export interface GitHubBotTurnTransition {
  readonly phase: 'open' | 'close';
  /** Canonical known-bot login (lower-cased) — the turn's identity. */
  readonly bot: string;
  /** Epoch ms the comment/review was written; orders transitions inside one batch. */
  readonly at: number;
}

/** Minimal shape the turn folder needs; keeps this module free of the event type. */
export interface BotTurnCarrier {
  readonly id: number | string;
  /** Which GitHub surface this came from; lets a consumer find the item that closed a round. */
  readonly source?: string;
  /** The GitHub review this artifact belongs to, when it is part of one. */
  readonly reviewId?: number;
  /** The commit this artifact is about, when GitHub gives us one. */
  readonly commitId?: string;
  /**
   * True for artifacts that are ALWAYS about a specific commit — a formal review and its inline
   * findings. For those, a missing `commitId` means "we could not tell", never "it is about the
   * current one", so it must not be allowed to end a round.
   */
  readonly commitBearing?: boolean;
  readonly botTurn?: GitHubBotTurnTransition;
}

function canonicalLogin(login: string): string {
  return login.trim().toLowerCase();
}

/** GitHub renders a bot mention without the `[bot]` suffix: `@chatgpt-codex-connector`. */
function mentionHandle(login: string): string {
  return canonicalLogin(login).replace(/\[bot\]$/, '');
}

/** Who answered: match against the answering login (`[bot]` suffix optional). */
export function resolveKnownBotAuthor(author: string, known: readonly KnownBot[] = KNOWN_BOTS): string | null {
  const candidate = canonicalLogin(author);
  const match = known.find((bot) => canonicalLogin(bot.login) === candidate || mentionHandle(bot.login) === candidate);
  return match ? canonicalLogin(match.login) : null;
}

const MENTION_RE = /(^|[^\w/-])@([A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?(?:\[bot\])?)/g;

function matchesHandle(mentioned: string, bot: KnownBot): boolean {
  const candidate = canonicalLogin(mentioned);
  return (
    canonicalLogin(bot.login) === candidate ||
    mentionHandle(bot.login) === candidate ||
    bot.triggerHandles.some((handle) => canonicalLogin(handle) === candidate)
  );
}

/**
 * Does this body mention a known bot at all? Used only to NAME the event `bot_interaction`
 * (so a maintainer can mute someone else's bot chatter). Mentioning is not summoning.
 */
export function resolveMentionedKnownBot(body: string, known: readonly KnownBot[] = KNOWN_BOTS): string | null {
  for (const match of body.matchAll(MENTION_RE)) {
    const mentioned = match[2];
    if (!mentioned) continue;
    const bot = known.find((candidate) => matchesHandle(mentioned, candidate));
    if (bot) return canonicalLogin(bot.login);
  }
  return null;
}

/**
 * Did this body SUMMON a known bot — i.e. is it the command that creates an expectation of an
 * answer? Only a command opens a round, because only a command can go unanswered. "I'll ask
 * @codex later" mentions the bot but promises nothing, and treating it as a round would emit a
 * fabricated "never answered" thirty minutes later.
 *
 * This is the same shape the registration-time coverage verifier enforces; both read it from
 * here so "what is a trigger" cannot drift into two answers.
 */
export function resolveSummonedKnownBot(body: string, known: readonly KnownBot[] = KNOWN_BOTS): string | null {
  const head = body.trimStart();
  for (const bot of known) {
    const handles = [mentionHandle(bot.login), ...bot.triggerHandles];
    for (const handle of handles) {
      const pattern = new RegExp(`^@${handle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s+review(?:\\s|$)`, 'i');
      if (pattern.test(head)) return canonicalLogin(bot.login);
    }
  }
  return null;
}

export function classifyBotTurnTransition(input: {
  readonly author: string;
  readonly body: string;
  readonly at: number;
  readonly knownBots?: readonly KnownBot[];
}): GitHubBotTurnTransition | undefined {
  const known = input.knownBots ?? KNOWN_BOTS;
  const responder = resolveKnownBotAuthor(input.author, known);
  if (responder) return { phase: 'close', bot: responder, at: input.at };
  const summoned = resolveSummonedKnownBot(input.body, known);
  if (summoned) return { phase: 'open', bot: summoned, at: input.at };
  return undefined;
}

/** A close applies before an open at the same instant — see replayBotTurns. */
const PHASE_ORDER = { close: 0, open: 1 } as const;

export interface BotTurnClosure {
  /** Canonical bot login whose answer closed a round. */
  readonly bot: string;
  /** The round that was open AT THAT MOMENT — not merely one that existed somewhere in the batch. */
  readonly round: GitHubBotTurn;
  /**
   * The item that closed it. A consumer must be able to ask "what did THIS answer say", instead
   * of scanning the whole batch by a fixed type priority: with several rounds in one batch, that
   * priority reported an older round's clean verdict while the batch ended in a new failure.
   */
  readonly by: {
    readonly id: number | string;
    readonly source?: string;
    readonly reviewId?: number;
    readonly commitId?: string;
    readonly at: number;
  };
}

export interface BotTurnReplay {
  /** Rounds still open once the whole batch is applied. */
  readonly state: Record<string, GitHubBotTurn>;
  /** Rounds an answer in this batch actually closed, in the order the answers happened. */
  readonly closures: readonly BotTurnClosure[];
}

/**
 * Replay one batch of transitions over the previous open-round state, in time order.
 *
 * Ordered by the underlying write time. Array position cannot be used (the caller emits all
 * comments before all reviews) and ids cannot be used either — review ids and comment ids are
 * different GitHub sequences and are not comparable with each other.
 *
 * GitHub timestamps have ONE-SECOND granularity, so ties are ordinary, not exotic. At a tie a
 * `close` applies before an `open`: a bot answer that shares a second with a trigger comment
 * belongs to the round that was already open, because no bot reviews a diff within the same
 * second it was asked. Sorting the other way deleted the freshly opened round — the exact
 * counterexample "old round answered at T, author opens a new round at T" returned `{}`.
 *
 * Replaying rather than folding is what makes `closures` trustworthy: an answer can only close a
 * round that was open BEFORE it. Collecting "every round the batch touched" and then attributing
 * any answer to that set reported bot chatter as the failure of a round opened a minute LATER.
 *
 * Residual case, stated rather than hidden: a bot that genuinely answers inside the same second
 * leaves its round open, and A28 reports one "never answered" thirty minutes later. That is a
 * visible false alarm; the alternative is a silently dropped round, and F280 A26 puts silence
 * strictly below noise.
 */
export function replayBotTurns(
  previous: Readonly<Record<string, GitHubBotTurn>> | undefined,
  carriers: readonly BotTurnCarrier[],
  headSha?: string,
): BotTurnReplay {
  const state: Record<string, GitHubBotTurn> = { ...previous };
  const closures: BotTurnClosure[] = [];
  const ordered = carriers
    .filter((carrier) => carrier.botTurn)
    .sort(
      (left, right) =>
        (left.botTurn?.at ?? 0) - (right.botTurn?.at ?? 0) ||
        PHASE_ORDER[left.botTurn?.phase ?? 'open'] - PHASE_ORDER[right.botTurn?.phase ?? 'open'] ||
        // Deterministic on a full tie. GitHub timestamps are second-granularity, so ties are
        // ordinary; leaving them to array order made the verdict depend on the order the caller
        // happened to build the batch in, which is not a fact about anything.
        `${left.source ?? ''}:${left.id}`.localeCompare(`${right.source ?? ''}:${right.id}`),
    );
  for (const carrier of ordered) {
    const turn = carrier.botTurn;
    if (!turn) continue;
    if (turn.phase === 'close') {
      const round = state[turn.bot];
      // An answer about a DIFFERENT commit does not end a round that is waiting on this one, and
      // neither does one whose commit we cannot establish. Deciding later, in the classifier, was
      // already too late: the round had been deleted by then, so a stale review arriving after a
      // new push closed the live round and reported its own old verdict as the current one.
      //
      // Unknown is NOT a match. A review artifact is always about some commit; if we cannot see
      // which, assuming "the current one" is the same false confidence in a new place.
      if (round?.headSha && carrier.commitBearing && carrier.commitId !== round.headSha) continue;
      if (round) {
        closures.push({
          bot: turn.bot,
          round,
          by: {
            id: carrier.id,
            ...(carrier.source ? { source: carrier.source } : {}),
            ...(carrier.reviewId ? { reviewId: carrier.reviewId } : {}),
            ...(carrier.commitId ? { commitId: carrier.commitId } : {}),
            at: turn.at,
          },
        });
        delete state[turn.bot];
      }
      continue;
    }
    state[turn.bot] = {
      triggerId: typeof carrier.id === 'number' ? carrier.id : 0,
      openedAt: turn.at,
      ...(headSha ? { headSha } : {}),
    };
  }
  return { state, closures };
}

/** Convenience wrapper for callers that only need the resulting open-round state. */
export function foldBotTurns(
  previous: Readonly<Record<string, GitHubBotTurn>> | undefined,
  carriers: readonly BotTurnCarrier[],
  headSha?: string,
): Record<string, GitHubBotTurn> {
  return replayBotTurns(previous, carriers, headSha).state;
}

export type ExpiredBotTurn = GitHubBotTurn & { readonly bot: string };

export function expiredBotTurns(
  turns: Readonly<Record<string, GitHubBotTurn>>,
  clock: { readonly now?: number; readonly botTurnTimeoutMs?: number } | undefined,
): readonly ExpiredBotTurn[] {
  const now = clock?.now;
  if (now === undefined) return [];
  const timeoutMs = clock?.botTurnTimeoutMs ?? BOT_TURN_TIMEOUT_MS;
  return Object.entries(turns)
    .filter(([, turn]) => now - turn.openedAt >= timeoutMs)
    .map(([bot, turn]) => ({ ...turn, bot }));
}
