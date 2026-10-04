/**
 * F246 / F322 S3-2b-2: the latest decision attempt per proposal, as evidence another host can read.
 *
 * This records what one request saw, nothing about what the decision became. A host that renders the same card elsewhere
 * (the 待办 panel) needs it to tell a final 401 from a 403 from "the request may or may not have landed", which the
 * store's single global `error` string cannot. It is:
 *  - transient: never persisted, never part of `items` or `count`, not a lifecycle. Whether a proposal was decided is for a
 *    canonical re-read to say, and the absence of an attempt never means success;
 *  - fenced: every attempt has a monotonic id, a newer attempt replaces the older at once, and an answer arriving for an
 *    attempt that is no longer the current one is dropped, so a late old 403 cannot dress up a newer request;
 *  - raw: the HTTP status the server answered, `transport_unknown` when no response came back at all, `client_validation`
 *    when the card refused before sending. 400/409/5xx are not classified here ("refused" would claim more than a generic
 *    store knows: a 5xx can land after the side effect, a 409 can be a typed conflict the producer card handles itself).
 */
import type { ApprovalHubItem } from '@cat-cafe/shared';

export type DecisionActionKind =
  | 'approve'
  | 'reject'
  | 'person-memory-approve'
  | 'person-memory-not-now'
  | 'person-memory-withdraw'
  | 'entity-resolve';

export type DecisionAttemptState =
  | { phase: 'submitting' }
  | { phase: 'response_received'; status: number; ok: boolean; errorCode?: string; message?: string }
  | { phase: 'transport_unknown' }
  | { phase: 'client_validation'; reason: string };

export interface DecisionAttempt {
  /** Monotonic across the store, so "newer" is a plain comparison. */
  attemptId: number;
  action: DecisionActionKind;
  /** With `proposalId` (the map key) and `createdAt`, the exact item this attempt was made against. */
  sourceFeatureId: ApprovalHubItem['sourceFeatureId'] | undefined;
  createdAt: number | undefined;
  state: DecisionAttemptState;
}

export type DecisionAttempts = Record<string, DecisionAttempt>;

/** The slice of store state this module reads and writes. */
export interface DecisionAttemptsSlice {
  decisionAttempts: DecisionAttempts;
}

type AttemptsUpdate = (
  update: Partial<DecisionAttemptsSlice> | ((state: DecisionAttemptsSlice) => Partial<DecisionAttemptsSlice>),
) => void;

let lastAttemptId = 0;

/** A request that was refused before anything was sent (not an HTTP failure and not a lost connection). */
export class DecisionNotSent extends Error {}

/**
 * Replace the proposal's attempt with a fresh submitting one and return a recorder bound to exactly that attempt. Whatever
 * the recorder reports later lands only while this attempt is still the current one.
 */
export function beginDecisionAttempt(
  set: AttemptsUpdate,
  proposalId: string,
  action: DecisionActionKind,
  item: Pick<ApprovalHubItem, 'sourceFeatureId' | 'createdAt'> | undefined,
) {
  lastAttemptId += 1;
  const attemptId = lastAttemptId;
  set((state) => ({
    decisionAttempts: {
      ...state.decisionAttempts,
      [proposalId]: {
        attemptId,
        action,
        sourceFeatureId: item?.sourceFeatureId,
        createdAt: item?.createdAt,
        state: { phase: 'submitting' },
      },
    },
  }));

  const settle = (next: DecisionAttemptState) =>
    set((state) => {
      const current = state.decisionAttempts[proposalId];
      if (current?.attemptId !== attemptId) return {};
      return { decisionAttempts: { ...state.decisionAttempts, [proposalId]: { ...current, state: next } } };
    });

  let responded = false;
  return {
    attemptId,
    /** The server answered. `body` is the parsed error body when the answer was a failure. */
    received(response: { status: number; ok: boolean }, body?: { error?: unknown; message?: unknown }) {
      responded = true;
      settle({
        phase: 'response_received',
        status: response.status,
        ok: response.ok,
        ...(typeof body?.error === 'string' ? { errorCode: body.error } : {}),
        ...(typeof body?.message === 'string' ? { message: body.message } : {}),
      });
    },
    /** The card refused before sending anything. */
    refused(reason: string) {
      settle({ phase: 'client_validation', reason });
    },
    /**
     * Something threw. Before any response it is either a refusal to send (the card knows the request is not one it may
     * make) or a request that may or may not have landed; after a response it is the card's own handling and changes nothing.
     */
    failed(error: unknown) {
      if (responded) return;
      if (error instanceof DecisionNotSent) settle({ phase: 'client_validation', reason: error.message });
      else settle({ phase: 'transport_unknown' });
    },
  };
}

/** Drop the attempt, but only if it is still the one the caller read; a newer attempt is not the caller's to clear. */
export function consumeDecisionAttempt(attempts: DecisionAttempts, proposalId: string, attemptId: number) {
  if (attempts[proposalId]?.attemptId !== attemptId) return attempts;
  const next = { ...attempts };
  delete next[proposalId];
  return next;
}
