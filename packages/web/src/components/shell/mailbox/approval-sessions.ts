import type { ApprovalHubItem, UnifiedAttentionVisibleApproval } from '@cat-cafe/shared';
import type { ApprovalRequestEvent, AuthorizeOptions } from '@/components/ApprovalHost';
import type { DecisionAttempt } from '@/stores/approval-decision-attempts';
import type { MailboxRead } from '../unified-mailbox-state';
import {
  type AttemptEvidence,
  describeReconcile,
  INITIAL_RECONCILE,
  type ReconcileEvent,
  type ReconcileModel,
  reduceReconcile,
} from './approval-reconcile';
import {
  type ApprovalAddress,
  type BuildReadEvidenceInput,
  buildReadEvidence,
  listedCopiesAligned,
} from './read-evidence';

/**
 * F322 S3-2b-1c: the driver that follows an approval hosted in the 待办 panel from the press of a button to a result it can
 * stand behind. The reconciler (pure) decides what may be said; this makes its inputs true:
 *
 *  - it follows only attempts made after the session opened, against this exact item (producer and version);
 *  - when a write has ended it starts one new unified read AND one Approval Hub store refresh, and judges only a read that
 *    began after the write ended (a generation of the panel's own reads, not a clock), and only after the store refresh
 *    has finished, because alignment compares the read with the store's copy;
 *  - it never declares "已处理" from the store's optimistic removal or from absence from a page: only a settled row for this
 *    owner, producer and proposal does that (see `buildReadEvidence`);
 *  - an answer that is no longer for the read now current is dropped, whichever finishes first;
 *  - it is asked synchronously, right before each producer write, whether the displayed read and the store still agree.
 *
 * A session lives here, not in a component: the row it belongs to leaves the list the moment the decision is made, and the
 * result must outlive that. Framework-free on purpose, so the dependencies are plain functions.
 */
export interface SessionSeed {
  /** The verified owner the card was shown to (the read's identity). */
  ownerUserId: string;
  decisionRef: string;
  /** The approval as the read showed it; kept so a result can still say what it was about after the row is gone. */
  approval: UnifiedAttentionVisibleApproval;
}

export interface ApprovalSession {
  key: string;
  ownerUserId: string;
  address: ApprovalAddress;
  decisionRef: string;
  approval: UnifiedAttentionVisibleApproval;
  model: ReconcileModel;
  /** Why the last press was refused before anything was sent, or null. The host's own sentence, not a result. */
  notice: string | null;
}

export interface SessionsDeps {
  /** Reads started so far (`UnifiedAttentionView.readsStarted`). */
  readsStarted(): number;
  /** Start a new unified read (the count moves synchronously). */
  refetch(): void;
  /** Refresh the Approval Hub store's pending list. May reject; the outcome is judged on what the store then holds. */
  refreshStore(): Promise<unknown>;
  storeItems(): readonly ApprovalHubItem[];
  attempts(): Readonly<Record<string, DecisionAttempt>>;
  /** The read now current and its generation (null while one is in flight). */
  latestRead(): { result: MailboxRead; generation: number | null };
  now(): number;
  lookupSettled?: BuildReadEvidenceInput['lookupSettled'];
}

export interface ApprovalSessions {
  /** Start (or find) the session for an approval. Idempotent: an existing session keeps its progress and its snapshot. */
  open(seed: SessionSeed): ApprovalSession;
  get(key: string): ApprovalSession | undefined;
  /** Stable between changes, so it can be a store snapshot. */
  list(): readonly ApprovalSession[];
  subscribe(listener: () => void): () => void;
  getVersion(): number;
  /** The Approval Hub store's attempt records changed: follow the ones that are this session's. */
  attemptsChanged(): void;
  /** A card that records no store attempt (meeting intake) reports its own request here. */
  hostReport(key: string, event: ApprovalRequestEvent): void;
  /** The current unified read settled: judge every session that is waiting on a read. */
  readSettled(): void;
  /** The user asked to read again. */
  reread(key: string): void;
  /**
   * Right before a producer write: may the card send it? Decided now, synchronously. A press is refused while a write is in
   * flight. The next request of a write this session already let out (`continuation`) is judged instead by whether what the
   * user was looking at has moved since: a newer read, another owner, a different version in the store.
   */
  authorize(key: string, options?: AuthorizeOptions): boolean;
  close(key: string): void;
}

export function sessionKey(ownerUserId: string, address: ApprovalAddress): string {
  return `${ownerUserId}|${address.sourceFeatureId}|${address.proposalId}`;
}

const REFUSAL_NOTICE = '这件事刚刚有变化，这次没有提交。已重新读取，请确认后再处理。';

/** The card that reports its own request for the kinds that leave no store attempt. */
const SELF_REPORTED_KIND = 'meeting-intake';

const isHttpStatus = (value: unknown): value is number =>
  Number.isInteger(value) && (value as number) >= 100 && (value as number) <= 599;

function maxAttemptId(attempts: Readonly<Record<string, DecisionAttempt>>): number {
  let max = 0;
  for (const attempt of Object.values(attempts)) {
    if (Number.isInteger(attempt?.attemptId) && attempt.attemptId > max) max = attempt.attemptId;
  }
  return max;
}

/** The store's attempt for this exact item, or null: another producer's or another version's is not this card's. */
function attemptFor(
  attempts: Readonly<Record<string, DecisionAttempt>>,
  session: ApprovalSession,
): { attemptId: number; state: AttemptEvidence } | null {
  const raw = attempts[session.address.proposalId];
  if (!raw || !Number.isInteger(raw.attemptId)) return null;
  if (raw.sourceFeatureId !== session.address.sourceFeatureId) return null;
  if (raw.createdAt === undefined || raw.createdAt !== session.approval.createdAt) return null;
  return { attemptId: raw.attemptId, state: raw.state };
}

export function createApprovalSessions(deps: SessionsDeps): ApprovalSessions {
  const sessions = new Map<string, ApprovalSession>();
  const refreshes = new Map<string, Promise<void>>();
  const evaluating = new Set<string>();
  /** The read generation at which each write that is in flight was allowed to go out. */
  const allowedAt = new Map<string, number>();
  const listeners = new Set<() => void>();
  let version = 0;
  let snapshot: readonly ApprovalSession[] = [];

  function commit(key: string, next: ApprovalSession | null) {
    if (next) sessions.set(key, next);
    else sessions.delete(key);
    snapshot = [...sessions.values()];
    version += 1;
    for (const listener of [...listeners]) listener();
  }

  function startConfirmation(key: string) {
    // The read first, so its generation is already counted when the store answers; both begin after the write ended.
    deps.refetch();
    refreshStoreFor(key);
  }

  function refreshStoreFor(key: string) {
    let pending: Promise<unknown>;
    try {
      pending = Promise.resolve(deps.refreshStore());
    } catch {
      pending = Promise.resolve();
    }
    // A failed refresh is not an exception here: alignment is judged on whatever the store holds afterwards.
    refreshes.set(
      key,
      pending.then(
        () => undefined,
        () => undefined,
      ),
    );
  }

  function apply(key: string, event: ReconcileEvent) {
    const session = sessions.get(key);
    if (!session) return;
    const before = session.model;
    const model = reduceReconcile(before, event);
    if (model === before) return;
    commit(key, { ...session, model, notice: null });

    const was = before.state;
    const now = model.state;
    if (now.kind !== 'writing') allowedAt.delete(key);
    const newConfirmation =
      now.kind === 'confirming' &&
      (was.kind !== 'confirming' || was.attemptId !== now.attemptId || was.afterGeneration !== now.afterGeneration);
    if (newConfirmation) startConfirmation(key);
  }

  async function evaluate(key: string, tag: string, result: MailboxRead, generation: number) {
    try {
      const session = sessions.get(key);
      if (!session) return;
      await (refreshes.get(key) ?? Promise.resolve());
      const evidence = await buildReadEvidence({
        generation,
        result,
        address: session.address,
        shownToOwnerUserId: session.ownerUserId,
        storeItems: deps.storeItems(),
        now: deps.now(),
        lookupSettled: deps.lookupSettled,
      });
      // The answer is for the read that was current when it was asked. If a newer one has begun or finished since, this
      // one is old, however late it is only now arriving.
      if (deps.latestRead().generation !== generation) return;
      const current = sessions.get(key);
      if (!current || current.model.state.kind !== 'confirming') return;
      apply(key, { type: 'read', read: evidence });
    } finally {
      evaluating.delete(tag);
    }
  }

  /**
   * The generation of the read on screen if it is current (no newer one started or in flight), is the owner's, still lists the
   * decision, and the Approval Hub store holds the same decision; otherwise null. One rule for a press and for the next request
   * of a write already out, so the two cannot drift apart.
   */
  function displayedDecisionGeneration(session: ApprovalSession): number | null {
    const { result, generation } = deps.latestRead();
    const current =
      result.kind === 'ok' &&
      generation !== null &&
      result.read.identity.ownerUserId === session.ownerUserId &&
      listedCopiesAligned(result.read, session.address, deps.storeItems(), deps.now());
    return current ? generation : null;
  }

  /**
   * The next request of a write this session let out. Not a new press: it may go only while that write is still in flight and
   * nothing the user was looking at when it was allowed has moved since (no newer read, same owner, the decision still listed
   * and the same in the store, so the revision they saw is the revision that is acted on).
   */
  function mayContinue(session: ApprovalSession): boolean {
    if (session.model.state.kind !== 'writing') return false;
    const allowed = allowedAt.get(session.key);
    return allowed !== undefined && allowed === deps.readsStarted() && displayedDecisionGeneration(session) === allowed;
  }

  function refuse(key: string) {
    const session = sessions.get(key);
    if (!session) return;
    commit(key, { ...session, notice: REFUSAL_NOTICE });
    // A read already on its way is the fresh read; starting another would only cancel it.
    if (deps.latestRead().generation !== null) deps.refetch();
    refreshStoreFor(key);
  }

  return {
    open(seed) {
      const approval = seed.approval;
      const address = { sourceFeatureId: approval.sourceFeatureId, proposalId: approval.proposalId };
      const key = sessionKey(seed.ownerUserId, address);
      const existing = sessions.get(key);
      if (existing) return existing;
      const session: ApprovalSession = {
        key,
        ownerUserId: seed.ownerUserId,
        address,
        decisionRef: seed.decisionRef,
        approval,
        // What the store recorded before this card was opened is not this card's answer.
        model: { ...INITIAL_RECONCILE, seenAttemptId: maxAttemptId(deps.attempts()) },
        notice: null,
      };
      commit(key, session);
      return session;
    },

    get: (key) => sessions.get(key),
    list: () => snapshot,
    getVersion: () => version,
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },

    attemptsChanged() {
      const attempts = deps.attempts();
      for (const session of [...sessions.values()]) {
        const attempt = attemptFor(attempts, session);
        if (!attempt) continue;
        apply(session.key, { type: 'attempt', attempt, readGeneration: deps.readsStarted() });
      }
    },

    hostReport(key, event) {
      if (event.kind !== SELF_REPORTED_KIND) return;
      const session = sessions.get(key);
      if (!session) return;
      const readGeneration = deps.readsStarted();
      if (event.phase === 'start') {
        const attemptId = session.model.seenAttemptId + 1;
        apply(key, { type: 'attempt', attempt: { attemptId, state: { phase: 'submitting' } }, readGeneration });
        return;
      }
      // An end without its start is not a request this session knows.
      if (session.model.state.kind !== 'writing') return;
      const attemptId = session.model.state.attemptId;
      // Only what the card itself saw is carried over. `settled` is a 2xx, or a deliberate stop between two requests with
      // nothing answered; an http error without a readable status is an answer we cannot read. None of those is "no response",
      // so none may be worded as one: the operation ended, and the re-read says the rest. Only a real network error is "none".
      const state: AttemptEvidence =
        event.outcome === 'network-error'
          ? { phase: 'transport_unknown' }
          : event.outcome === 'http-error' && isHttpStatus(event.status)
            ? { phase: 'response_received', status: event.status, ok: false }
            : { phase: 'ended' };
      apply(key, { type: 'attempt', attempt: { attemptId, state }, readGeneration });
    },

    readSettled() {
      const { result, generation } = deps.latestRead();
      if (generation === null || result.kind === 'loading') return;
      for (const session of [...sessions.values()]) {
        const { state } = session.model;
        if (state.kind !== 'confirming' || generation <= state.afterGeneration) continue;
        const tag = `${session.key}#${generation}`;
        if (evaluating.has(tag)) continue;
        evaluating.add(tag);
        void evaluate(session.key, tag, result, generation);
      }
    },

    reread(key) {
      apply(key, { type: 'reread', readGeneration: deps.readsStarted() });
    },

    authorize(key, options) {
      const session = sessions.get(key);
      if (!session) return false;
      if (options?.continuation === true) return mayContinue(session);
      // Locked states are being handled (a write in flight, a result being confirmed, a result the user must re-read).
      if (describeReconcile(session.model.state).actions !== 'allowed') return false;

      const generation = displayedDecisionGeneration(session);
      if (generation === null) {
        refuse(key);
        return false;
      }
      allowedAt.set(key, generation);
      if (session.notice !== null) commit(key, { ...session, notice: null });
      return true;
    },

    close(key) {
      if (!sessions.has(key)) return;
      refreshes.delete(key);
      allowedAt.delete(key);
      commit(key, null);
    },
  };
}
