'use client';

import type { UnifiedAttentionReadV1 } from '@cat-cafe/shared';
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { apiFetch } from '@/utils/api-client';
import { apiSessionIdentity, observeApiSessionOwner } from '@/utils/api-session-identity';
import { parseUnifiedAttentionRead } from './parse-unified-attention';
import { UNIFIED_ATTENTION_INVALIDATION_EVENTS } from './unified-attention-events';
import type { MailboxRead } from './unified-mailbox-state';

/** F310's Host owner read. Pages remain independent owner-fenced reads, with 20 rows per request. */
export const UNIFIED_ATTENTION_PATH =
  '/api/concierge/work/decisions?view=unified&includeUserMentions=true&offset=0&limit=20&personalView=visible';

/** The original invalidation chain: approvals (F246) and entrusted work / runtime interactions (F310). No new subscription. */
export { UNIFIED_ATTENTION_INVALIDATION_EVENTS } from './unified-attention-events';

export type MentionPeriod = 'recent' | 'today' | 'week' | 'earlier' | 'handled' | 'all';
export type MailboxPersonalView = 'visible' | 'ignored';
export interface UnifiedAttentionView {
  setPersonalView?: (mode: MailboxPersonalView, period?: MentionPeriod) => void;
  setMentionPeriod?: (period: MentionPeriod) => void;
  result: MailboxRead;
  /** Last confirmed count for this scope during refresh; never used to authorize panel actions. */
  badgeResult?: MailboxRead;
  /**
   * Only while a re-read is in flight after a successful one: the rows read last time. The panel may keep showing
   * them labelled as the previous read; nothing may count them as current. It is dropped on failure.
   */
  staleRead: UnifiedAttentionReadV1 | null;
  refetch: () => void;
  nextPage?: () => void;
  previousPage?: () => void;
  /** Contiguous physical pages of the current owner/query and invalidation epoch. Not independent action authority. */
  pages?: UnifiedAttentionReadV1[];
  /** Pages verified since the latest first-page refresh; older display pages cannot authorize actions. */
  currentPages?: UnifiedAttentionReadV1[];
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
async function readOnce(
  signal: AbortSignal,
  onPrincipal: (principal: string | null) => void,
  offset: number,
  period: MentionPeriod,
  mode: MailboxPersonalView,
): Promise<MailboxRead> {
  const principalRead: Promise<string | null> = apiFetch('/api/session', { signal })
    .then(sessionUserId)
    .catch(() => null);
  void principalRead.then(onPrincipal);
  try {
    const path =
      UNIFIED_ATTENTION_PATH.replace('offset=0', `offset=${offset}`).replace(
        'personalView=visible',
        `personalView=${mode}`,
      ) + (period === 'week' ? '' : `&mentionPeriod=${period}`);
    const unified = await apiFetch(path, { signal }, { afterCurrentGet: true });
    // Both GETs started together. Even a fast 5xx needs this round's owner before retaining history.
    const principal = await principalRead;
    if (unified.status === 401) return { kind: 'failed', reason: 'unauthenticated' };
    // 503 is the structured "every source unavailable" read; 200 is available or partial. Anything else is a refusal.
    if (unified.status !== 200 && unified.status !== 503) return { kind: 'failed', reason: 'unavailable' };

    const read = parseUnifiedAttentionRead(await unified.json().catch(() => null));
    if (
      !read ||
      read.page.offset !== offset ||
      read.page.limit !== 20 ||
      read.personalView?.mode !== mode ||
      (read.mentionPeriod ?? 'week') !== period
    )
      return { kind: 'failed', reason: 'unavailable' };
    if (principal === null || read.identity.ownerUserId !== principal) return { kind: 'failed', reason: 'unavailable' };
    return { kind: 'ok', read };
  } catch {
    await principalRead;
    return { kind: 'failed', reason: 'unavailable' };
  }
}

const queryKey = (mode: MailboxPersonalView, period: MentionPeriod, offset: number) => `${mode}:${period}:${offset}`;

export function useUnifiedAttention(): UnifiedAttentionView {
  const identity = useSyncExternalStore(
    apiSessionIdentity.subscribe,
    apiSessionIdentity.getSnapshot,
    apiSessionIdentity.getSnapshot,
  );
  const [result, setResult] = useState<MailboxRead>({ kind: 'loading' });
  const [badgeResult, setBadgeResult] = useState<MailboxRead>({ kind: 'loading' });
  const [staleRead, setStaleRead] = useState<UnifiedAttentionReadV1 | null>(null);
  const [resultGeneration, setResultGeneration] = useState<number | null>(null);
  const lastOkRef = useRef<UnifiedAttentionReadV1 | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const startedRef = useRef(0);
  const pageEpoch = useRef(0);
  const periodRef = useRef<MentionPeriod>('week');
  const modeRef = useRef<MailboxPersonalView>('visible');
  const offsetRef = useRef(0);
  const ownerRef = useRef<string | null>(null);
  const queryCache = useRef(new Map<string, { read: UnifiedAttentionReadV1; generation: number }>());
  const readsStarted = useCallback(() => startedRef.current, []);

  const startRead = useCallback((offset: number) => {
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    const mode = modeRef.current;
    const period = periodRef.current;
    offsetRef.current = offset;
    const cached = queryCache.current.get(queryKey(mode, period, offset));
    const previous = cached?.read ?? lastOkRef.current;
    const sameScope = previous && previous.personalView?.mode === mode && (previous.mentionPeriod ?? 'week') === period;
    setBadgeResult(sameScope ? { kind: 'ok', read: previous } : { kind: 'loading' });
    let settled = false,
      verifiedPrincipal: string | null = null;
    const sessionGeneration = apiSessionIdentity.getSnapshot().generation;
    // Counted synchronously, before anything is awaited: a write that ends right now must see that this read has begun.
    startedRef.current += 1;
    const generation = startedRef.current;
    if (offset === 0) pageEpoch.current = generation;
    // Re-reading withdraws the previous claim: loading carries no number, no rows and no generation.
    setResult({ kind: 'loading' });
    setResultGeneration(null);
    // The previous rows belong to whoever read them. They are shown again only once THIS round's session is confirmed and
    // is that same owner — a changed, unknown or refused session never sees them, not even while waiting for the read.
    setStaleRead(null);
    void readOnce(
      controller.signal,
      (principal) => {
        if (settled || controller.signal.aborted) return;
        const currentIdentity = apiSessionIdentity.getSnapshot();
        if (currentIdentity.generation !== sessionGeneration && currentIdentity.ownerUserId !== principal) return;
        verifiedPrincipal = principal;
        if (ownerRef.current !== null && ownerRef.current !== principal) queryCache.current.clear();
        ownerRef.current = principal;
        observeApiSessionOwner(principal);
        if (!previous || principal !== previous.identity.ownerUserId) setBadgeResult({ kind: 'loading' });
        if (
          previous &&
          principal !== null &&
          previous.identity.ownerUserId === principal &&
          previous.personalView?.mode === mode &&
          (previous.mentionPeriod ?? 'week') === period
        )
          setStaleRead(previous);
      },
      offset,
      period,
      mode,
    ).then((next) => {
      // A newer read aborted this controller (or the hook is gone): this answer is no longer the current question's.
      if (controller.signal.aborted) return;
      settled = true;
      if (next.kind === 'ok' && next.read.identity.ownerUserId !== apiSessionIdentity.getSnapshot().ownerUserId)
        next = { kind: 'failed', reason: 'unavailable' };
      lastOkRef.current = next.kind === 'ok' ? next.read : null;
      const retainHistory =
        next.kind === 'failed' &&
        (period === 'handled' || mode === 'ignored') &&
        previous?.identity.ownerUserId === verifiedPrincipal &&
        verifiedPrincipal === apiSessionIdentity.getSnapshot().ownerUserId;
      if (retainHistory && previous) lastOkRef.current = previous;
      if (next.kind === 'ok') queryCache.current.set(queryKey(mode, period, offset), { read: next.read, generation });
      else if (!retainHistory) queryCache.current.clear();
      setStaleRead(retainHistory ? previous : null);
      setResult(next);
      setBadgeResult(next);
      setResultGeneration(generation);
    });
  }, []);

  const setPersonalView = useCallback(
    (mode: MailboxPersonalView, period?: MentionPeriod) => {
      const nextPeriod = period ?? periodRef.current;
      if (modeRef.current === mode && periodRef.current === nextPeriod && offsetRef.current === 0) return;
      modeRef.current = mode;
      periodRef.current = nextPeriod;
      const cached = queryCache.current.get(queryKey(mode, nextPeriod, 0));
      if (
        cached &&
        cached.read.identity.ownerUserId === ownerRef.current &&
        cached.read.identity.ownerUserId === apiSessionIdentity.getSnapshot().ownerUserId
      ) {
        abortRef.current?.abort();
        offsetRef.current = 0;
        lastOkRef.current = cached.read;
        setResult({ kind: 'ok', read: cached.read });
        setBadgeResult({ kind: 'ok', read: cached.read });
        setStaleRead(null);
        setResultGeneration(cached.generation === startedRef.current ? cached.generation : null);
        if (cached.generation !== startedRef.current) startRead(0);
      } else startRead(0);
    },
    [startRead],
  );
  const setMentionPeriod = useCallback(
    (period: MentionPeriod) => {
      if (periodRef.current === period && offsetRef.current === 0) return;
      setPersonalView(modeRef.current, period);
    },
    [setPersonalView],
  );
  const refetch = useCallback(() => startRead(0), [startRead]);
  const nextPage = useCallback(() => {
    const read = lastOkRef.current;
    if (read?.page.hasMore) startRead(read.page.offset + read.page.limit);
  }, [startRead]);
  const previousPage = useCallback(() => {
    const read = lastOkRef.current;
    if (read && read.page.offset > 0) startRead(Math.max(0, read.page.offset - read.page.limit));
  }, [startRead]);

  useEffect(() => {
    refetch();
    let queued = false,
      disposed = false;
    const onInvalidated = () => {
      // Keep old pages for display while withdrawing their action epoch synchronously in startRead.
      if (queued) return;
      queued = true;
      if (!disposed) refetch();
      queueMicrotask(() => {
        queued = false;
      });
    };
    for (const name of UNIFIED_ATTENTION_INVALIDATION_EVENTS) window.addEventListener(name, onInvalidated);
    return () => {
      disposed = true;
      for (const name of UNIFIED_ATTENTION_INVALIDATION_EVENTS) window.removeEventListener(name, onInvalidated);
      abortRef.current?.abort();
    };
  }, [refetch]);

  useEffect(() => {
    if (ownerRef.current && ownerRef.current !== identity.ownerUserId) {
      abortRef.current?.abort();
      queryCache.current.clear();
      lastOkRef.current = null;
      ownerRef.current = null;
      setStaleRead(null);
      setResultGeneration(null);
      if (identity.ownerUserId) startRead(0);
      else {
        setResult({ kind: 'failed', reason: 'unauthenticated' });
        setBadgeResult({ kind: 'failed', reason: 'unauthenticated' });
      }
    }
  }, [identity.ownerUserId, startRead]);
  const pages: UnifiedAttentionReadV1[] = [],
    currentPages: UnifiedAttentionReadV1[] = [];
  for (let offset = 0; ; offset += 20) {
    const cached = queryCache.current.get(queryKey(modeRef.current, periodRef.current, offset));
    if (!cached || cached.read.identity.ownerUserId !== ownerRef.current) break;
    pages.push(cached.read);
    if (cached.generation >= pageEpoch.current) currentPages.push(cached.read);
    if (!cached.read.page.hasMore) break;
  }
  return {
    pages,
    currentPages,
    result:
      result.kind === 'ok' && result.read.identity.ownerUserId !== identity.ownerUserId
        ? { kind: 'failed', reason: 'unavailable' }
        : result,
    badgeResult:
      badgeResult.kind === 'ok' && badgeResult.read.identity.ownerUserId !== identity.ownerUserId
        ? { kind: 'loading' }
        : badgeResult,
    staleRead: staleRead?.identity.ownerUserId === identity.ownerUserId ? staleRead : null,
    refetch,
    nextPage,
    previousPage,
    setMentionPeriod,
    setPersonalView,
    readsStarted,
    resultGeneration,
  };
}
