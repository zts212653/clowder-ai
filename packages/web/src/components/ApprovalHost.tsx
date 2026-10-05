'use client';

import { createContext, useCallback, useContext, useEffect, useRef } from 'react';

/**
 * The contract between an original approval card (F246 producers' own renderers) and whatever hosts it.
 *
 * The Approval Hub hosts its cards without any of this: the default value allows every write, locks nothing and reports
 * to nobody, so a card behaves exactly as before. A host that embeds the same cards elsewhere (the 待办 panel) provides a
 * real value to do three things the cards cannot know for themselves:
 *  - lock writes while what the card shows may not be what is true (a re-read in flight, a mismatch, an unknown result).
 *    A locked card keeps editing, cancel and Escape; it just sends nothing;
 *  - be asked right before every producer write, because "the server will refuse" is not a guard;
 *  - be told what the user is in the middle of (a feedback dialog, a form, a picked subset) and when a write starts and
 *    ends with what came back, because only the card knows, and its draft must outlive a re-read of the list.
 */
export type ApprovalWriteKind =
  | 'approve'
  | 'reject'
  | 'reject-feedback'
  | 'entity-resolve'
  | 'person-memory-approve'
  | 'person-memory-defer'
  | 'person-memory-withdraw'
  | 'meeting-intake';

export type ApprovalRequestEvent =
  | { phase: 'start'; kind: ApprovalWriteKind }
  /**
   * `settled`: the producer call returned and the card cannot tell more (the hub store swallows failures into one global
   * string). `http-error` carries the status the card actually saw. `network-error`: no response at all.
   */
  | { phase: 'end'; kind: ApprovalWriteKind; outcome: 'settled' | 'http-error' | 'network-error'; status?: number };

export interface AuthorizeOptions {
  /**
   * The request being asked about is the next one of a write this host already let out, not a new press: F292 saves the
   * destination's cat and then retries delivery, and the second request is asked about on its own. A host that locks writes
   * while one is in flight must still be able to answer this one, and may judge it by whether what the user was looking at
   * has moved since the write was allowed. A host that does not tell the two apart can ignore it.
   */
  readonly continuation?: boolean;
}

export interface ApprovalHost {
  /** Writes are locked for this card. Editing, cancel and Escape stay available. */
  readonly writesLocked: boolean;
  /** Asked immediately before every producer write. `false` means nothing is sent. */
  authorizeWrite(kind: ApprovalWriteKind, options?: AuthorizeOptions): boolean;
  /**
   * The user is (or is no longer) mid-edit. `source` names the editor so several can be reported at once. A plain function:
   * it is called detached from the host object, and its identity is what says "the same reporter".
   */
  reportEditing(source: string, editing: boolean): void;
  reportRequest(event: ApprovalRequestEvent): void;
}

export const PERMISSIVE_APPROVAL_HOST: ApprovalHost = {
  writesLocked: false,
  authorizeWrite: () => true,
  reportEditing: () => undefined,
  reportRequest: () => undefined,
};

export const ApprovalHostContext = createContext<ApprovalHost>(PERMISSIVE_APPROVAL_HOST);

export function useApprovalHost(): ApprovalHost {
  return useContext(ApprovalHostContext);
}

/** What a write saw of its own response, when it can tell. A write that cannot tell leaves the default (`settled`). */
export type WriteEvidence = { outcome: 'settled' | 'http-error' | 'network-error'; status?: number };

export type GuardedWrite = <T>(
  kind: ApprovalWriteKind,
  write: (reportEvidence: (evidence: WriteEvidence) => void) => Promise<T>,
) => Promise<{ sent: false } | { sent: true; value: T }>;

/**
 * Run one producer write behind the host's guard. The host is read at the moment of the write (a lock can flip between the
 * render that drew the button and the click), the write is announced, and what came back is reported — with the HTTP status
 * when the write itself saw one and said so. A write that throws is reported as a network error and the error is rethrown
 * to the card's own handling.
 *
 * A request belongs to the host that authorized it for as long as it lasts. If the card is handed a different host while
 * the request is in flight, the host that saw it start still sees it end and the new one never sees half of it: reading the
 * host again at each step would leave the first one waiting forever and give the second an end with no start.
 */
export function useGuardedWrite(): GuardedWrite {
  const host = useApprovalHost();
  const latest = useRef(host);
  latest.current = host;
  return useCallback<GuardedWrite>(async (kind, write) => {
    const requestHost = latest.current;
    if (!requestHost.authorizeWrite(kind)) return { sent: false };
    requestHost.reportRequest({ phase: 'start', kind });
    let evidence: WriteEvidence = { outcome: 'settled' };
    try {
      const value = await write((reported) => {
        evidence = reported;
      });
      requestHost.reportRequest({ phase: 'end', kind, ...evidence });
      return { sent: true, value };
    } catch (error) {
      requestHost.reportRequest({ phase: 'end', kind, outcome: 'network-error' });
      throw error;
    }
  }, []);
}

/**
 * Ask the host again, right now, for a request that is not the first of its write. A write that sends more than one request
 * (F292 saves the destination's cat, then retries delivery) was authorized for its first request; whatever the host knew
 * then may no longer hold when the second is about to go out. Read at the moment of the call, and from the host that is
 * current then: a lock lives on the host the card has now, while start and end of the write stay with the host that began it.
 */
export function useAuthorizeWrite(): (kind: ApprovalWriteKind) => boolean {
  const host = useApprovalHost();
  const latest = useRef(host);
  latest.current = host;
  // Only ever for the next request of a write that is already out: a new press goes through `useGuardedWrite`.
  return useCallback((kind) => latest.current.authorizeWrite(kind, { continuation: true }), []);
}

/** A card cannot write while it is already writing or while its host has locked writes. */
export function useWriteBlocked(writing: boolean): boolean {
  const host = useApprovalHost();
  return writing || host.writesLocked;
}

/**
 * Tell the host while this editor is in use, and that it is over when it goes away. Each stretch of editing begins and ends
 * with the same reporter: if the card is handed a different host mid-edit, the old one is told it is over and the new one
 * is told it is under way, so each sees a balanced pair. Only the reporter matters here: a host object that changes just
 * because its lock flipped, with the same reporter, does not restart anything.
 */
export function useReportEditing(source: string, editing: boolean): void {
  const { reportEditing } = useApprovalHost();
  useEffect(() => {
    if (!editing) return;
    reportEditing(source, true);
    return () => reportEditing(source, false);
  }, [source, editing, reportEditing]);
}
