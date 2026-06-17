'use client';

/**
 * F229 Liveness P0: useConciergeQueue — authoritative invocation status from server
 *
 * Polls /api/threads/:threadId/queue to get the real activeInvocations state.
 * This replaces the 60s local safety valve with server-truth-driven status.
 *
 * Only polls while `enabled` is true (i.e., while invocationStatus === 'in_progress').
 * Returns whether a duty cat invocation is actually running on the concierge thread.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { apiFetch } from '@/utils/api-client';

export type ConciergeQueueStatus = {
  /** Whether any duty cat invocation is currently running on the concierge thread */
  isRunning: boolean;
  /** True after the first successful /queue poll — before this, isRunning is not authoritative */
  loaded: boolean;
  /** The catId of the active duty cat, if any */
  dutyCatId: string | null;
  /** When the active invocation started (unix ms) */
  startedAt: number | null;
};

const EMPTY: ConciergeQueueStatus = { isRunning: false, loaded: false, dutyCatId: null, startedAt: null };

const POLL_INTERVAL_MS = 3000;
/** If queue polling never succeeds within this window, force-set loaded
 *  so the panel can recover to idle (replaces the old 60s blind safety valve
 *  for the "API unreachable" failure class). */
const POLL_DEADLINE_MS = 10_000;

export function useConciergeQueue(threadId: string | null, enabled: boolean): ConciergeQueueStatus {
  const [status, setStatus] = useState<ConciergeQueueStatus>(EMPTY);
  const threadIdRef = useRef(threadId);
  threadIdRef.current = threadId;

  const fetchQueue = useCallback(async (tid: string) => {
    try {
      const res = await apiFetch(`/api/threads/${encodeURIComponent(tid)}/queue`);
      if (!res.ok || threadIdRef.current !== tid) return;
      const data = await res.json();
      const active: Array<{ catId?: string; startedAt?: number }> = data.activeInvocations ?? [];
      const queued: Array<{ status?: string }> = data.queue ?? [];
      // A turn can be queued/processing but not yet in activeInvocations
      // (e.g., between 202-accepted and processor pickup). Treat both as "running"
      // so the concierge doesn't flash idle during the handoff gap.
      const hasPending = active.length > 0 || queued.length > 0;
      if (hasPending) {
        const first = active[0];
        setStatus({
          isRunning: true,
          loaded: true,
          dutyCatId: first?.catId ?? null,
          startedAt: first?.startedAt ?? null,
        });
      } else {
        setStatus({ ...EMPTY, loaded: true });
      }
    } catch {
      // Network error — keep previous state, don't flash empty
    }
  }, []);

  useEffect(() => {
    if (!enabled || !threadId) {
      setStatus(EMPTY);
      return;
    }
    // Fetch immediately on enable, then poll
    void fetchQueue(threadId);
    const id = setInterval(() => void fetchQueue(threadId), POLL_INTERVAL_MS);
    // Deadline fallback: if queue polling never succeeds (API unreachable),
    // force-set loaded after 30s so the panel can recover to idle.
    // This replaces the old 60s blind safety valve for sustained poll failure.
    const deadlineId = setTimeout(() => {
      setStatus((prev) => (prev.loaded ? prev : { ...EMPTY, loaded: true }));
    }, POLL_DEADLINE_MS);
    return () => {
      clearInterval(id);
      clearTimeout(deadlineId);
    };
  }, [enabled, threadId, fetchQueue]);

  return status;
}
