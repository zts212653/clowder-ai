'use client';

import type { UnifiedAttentionReadV1 } from '@cat-cafe/shared';
import { useCallback, useEffect, useRef, useState } from 'react';
import { apiFetch } from '@/utils/api-client';
import { parseUnifiedAttentionRead } from './parse-unified-attention';
import type { MailboxRead } from './unified-mailbox-state';

/** F310's Host owner read (limit is capped at 20 by the route). Only the first page is read here. */
export const UNIFIED_ATTENTION_PATH = '/api/concierge/work/decisions?view=unified&offset=0&limit=20';

/** The original invalidation chain: approvals (F246) and entrusted work / runtime interactions (F310). No new subscription. */
const INVALIDATION_EVENTS = [
  'cat-cafe:proposal-updated',
  'cat-cafe:proposal-created',
  'cat-cafe:runtime-interaction-updated',
  'cat-cafe:entrusted-work-projection-invalidated',
] as const;

export interface UnifiedAttentionView {
  result: MailboxRead;
  /**
   * Only while a re-read is in flight after a successful one: the rows read last time. The panel may keep showing
   * them labelled as the previous read; nothing may count them as current. It is dropped on failure.
   */
  staleRead: UnifiedAttentionReadV1 | null;
  refetch: () => void;
  /**
   * How many reads this hook has started so far, live: the mount read is the first and every re-read adds one, the moment it
   * starts. "After a write" is judged on this count and not on a clock (the client's and the server's clocks need not agree,
   * but the panel knows which of its own reads it started later). One stable function, so a host may keep it.
   */
  readsStarted: () => number;
  /**
   * The generation of the read behind `result` (its position in `readsStarted`), or null while a read is in flight. Failed
   * reads have one too: they are reads that were made and could not be used.
   */
  resultGeneration: number | null;
}

async function sessionUserId(response: Response): Promise<string | null> {
  if (!response.ok) return null;
  const body: unknown = await response.json().catch(() => null);
  const id = typeof body === 'object' && body !== null ? (body as { userId?: unknown }).userId : null;
  return typeof id === 'string' && id.trim().length > 0 ? id : null;
}

/**
 * One attempt. `loading` is never returned from here; a result is either a verified read or a failure. The read is only
 * trusted when its root identity equals the signed-in session's user — that is checked before any row can be rendered.
 * `onPrincipal` is told the session's user (or null when it cannot be confirmed) as soon as that is known, which may be
 * before the unified read answers.
 */
async function readOnce(signal: AbortSignal, onPrincipal: (principal: string | null) => void): Promise<MailboxRead> {
  const principalRead: Promise<string | null> = apiFetch('/api/session', { signal })
    .then(sessionUserId)
    .catch(() => null);
  void principalRead.then(onPrincipal);
  try {
    const unified = await apiFetch(UNIFIED_ATTENTION_PATH, { signal }, { afterCurrentGet: true });
    if (unified.status === 401) return { kind: 'failed', reason: 'unauthenticated' };
    // 503 is the structured "every source unavailable" read; 200 is available or partial. Anything else is a refusal.
    if (unified.status !== 200 && unified.status !== 503) return { kind: 'failed', reason: 'unavailable' };

    const read = parseUnifiedAttentionRead(await unified.json().catch(() => null));
    if (!read) return { kind: 'failed', reason: 'unavailable' };
    const principal = await principalRead;
    if (principal === null || read.identity.ownerUserId !== principal) return { kind: 'failed', reason: 'unavailable' };
    return { kind: 'ok', read };
  } catch {
    return { kind: 'failed', reason: 'unavailable' };
  }
}

export function useUnifiedAttention(): UnifiedAttentionView {
  const [result, setResult] = useState<MailboxRead>({ kind: 'loading' });
  const [staleRead, setStaleRead] = useState<UnifiedAttentionReadV1 | null>(null);
  const [resultGeneration, setResultGeneration] = useState<number | null>(null);
  const lastOkRef = useRef<UnifiedAttentionReadV1 | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const startedRef = useRef(0);
  const readsStarted = useCallback(() => startedRef.current, []);

  const refetch = useCallback(() => {
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    const previous = lastOkRef.current;
    let settled = false;
    // Counted synchronously, before anything is awaited: a write that ends right now must see that this read has begun.
    startedRef.current += 1;
    const generation = startedRef.current;
    // Re-reading withdraws the previous claim: loading carries no number, no rows and no generation.
    setResult({ kind: 'loading' });
    setResultGeneration(null);
    // The previous rows belong to whoever read them. They are shown again only once THIS round's session is confirmed and
    // is that same owner — a changed, unknown or refused session never sees them, not even while waiting for the read.
    setStaleRead(null);
    void readOnce(controller.signal, (principal) => {
      if (settled || controller.signal.aborted) return;
      if (previous && principal !== null && previous.identity.ownerUserId === principal) setStaleRead(previous);
    }).then((next) => {
      // A newer read aborted this controller (or the hook is gone): this answer is no longer the current question's.
      if (controller.signal.aborted) return;
      settled = true;
      lastOkRef.current = next.kind === 'ok' ? next.read : null;
      setStaleRead(null);
      setResult(next);
      setResultGeneration(generation);
    });
  }, []);

  useEffect(() => {
    refetch();
    const onInvalidated = () => refetch();
    for (const name of INVALIDATION_EVENTS) window.addEventListener(name, onInvalidated);
    return () => {
      for (const name of INVALIDATION_EVENTS) window.removeEventListener(name, onInvalidated);
      abortRef.current?.abort();
    };
  }, [refetch]);

  return { result, staleRead, refetch, readsStarted, resultGeneration };
}
