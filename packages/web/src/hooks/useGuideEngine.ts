'use client';

import { useEffect, useRef } from 'react';
import { syncLocalBootcampState } from '@/components/first-run-quest/syncLocalBootcampState';
import type { Thread } from '@/stores/chat-types';
import { useChatStore } from '@/stores/chatStore';
import type { OrchestrationFlow } from '@/stores/guideStore';
import { useGuideStore } from '@/stores/guideStore';
import { apiFetch } from '@/utils/api-client';

/**
 * F155/B-5: Guide Engine hook — Zustand-driven (no CustomEvent bridge).
 *
 * Subscribes to guideStore.pendingStart (set by Socket.io → reduceServerEvent).
 * Fetches flow definition from API, then calls startGuide().
 * On completion, notifies backend to transition guideState active → completed,
 * and auto-advances bootcamp phase when the guide is bootcamp-bound.
 */

/** Maps bootcamp-bound guide IDs to the next bootcamp phase on completion. */
const GUIDE_PHASE_ADVANCE: Record<string, string> = {
  'bootcamp-add-teammate': 'phase-8-collab',
  'bootcamp-farewell': 'phase-11-farewell',
};
export function useGuideEngine() {
  const currentThreadId = useChatStore((s) => s.currentThreadId);
  const startGuide = useGuideStore((s) => s.startGuide);
  const clearPendingStart = useGuideStore((s) => s.clearPendingStart);
  const exitGuide = useGuideStore((s) => s.exitGuide);
  const startInFlightRef = useRef<string | null>(null);

  // React to pendingStart changes from Zustand (set by Socket.io or InteractiveBlock)
  const pendingStart = useGuideStore((s) => s.pendingStart);
  useEffect(() => {
    if (!pendingStart) return;
    const { guideId, threadId } = pendingStart;

    const isActiveThread = () => useChatStore.getState().currentThreadId === threadId;
    // Check thread BEFORE clearing to prevent race-drop during thread switch
    if (!isActiveThread()) return;
    clearPendingStart();

    const hasActiveSession = () => {
      const session = useGuideStore.getState().session;
      return !!session && session.flow.id === guideId && session.threadId === threadId && session.phase !== 'complete';
    };

    const trigger = async () => {
      const startKey = `${threadId}::${guideId}`;
      if (!isActiveThread() || hasActiveSession()) return;
      if (startInFlightRef.current === startKey) return;
      startInFlightRef.current = startKey;
      try {
        const res = await apiFetch(`/api/guide-flows/${encodeURIComponent(guideId)}`);
        if (!res.ok) {
          console.error(`[Guide] Flow fetch failed (${res.status}), awaiting next guide_start event`);
          return;
        }
        const flow = (await res.json()) as OrchestrationFlow;
        if (!flow?.steps?.length) {
          console.warn(`[Guide] Empty flow: ${guideId}`);
          return;
        }
        if (!isActiveThread() || hasActiveSession()) return;
        // Ensure server-side guide session exists — client-triggered guides
        // (e.g. bootcamp) skip /api/guide-actions/start, so register here.
        apiFetch('/api/guide-actions/start', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ threadId, guideId }),
        }).catch(() => {}); // best-effort, don't block guide start
        startGuide(flow, threadId);
      } catch (err) {
        console.error(`[Guide] Failed to fetch flow "${guideId}":`, err);
      } finally {
        if (startInFlightRef.current === startKey) {
          startInFlightRef.current = null;
        }
      }
    };
    trigger();
  }, [pendingStart, startGuide, clearPendingStart, currentThreadId]);

  // Dev testing helper
  useEffect(() => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (window as any).__startGuide = (flowId: string, threadId?: string) => {
      useGuideStore.getState().reduceServerEvent({
        action: 'start',
        guideId: flowId,
        threadId: threadId ?? useChatStore.getState().currentThreadId ?? '',
      });
    };
    return () => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      delete (window as any).__startGuide;
    };
  }, []);

  // Completion callback: when phase becomes 'complete', notify backend.
  const session = useGuideStore((s) => s.session);
  const markCompletionPersisted = useGuideStore((s) => s.markCompletionPersisted);
  const markCompletionFailed = useGuideStore((s) => s.markCompletionFailed);

  useEffect(() => {
    if (!session?.threadId) return;
    if (currentThreadId === session.threadId) return;
    exitGuide();
  }, [currentThreadId, exitGuide, session?.threadId]);

  useEffect(() => {
    if (!session || session.phase !== 'complete') return;
    const { sessionId, threadId } = session;
    const guideId = session.flow.id;
    if (!threadId) return;

    const notify = async (attempt = 1): Promise<void> => {
      try {
        const res = await apiFetch('/api/guide-actions/complete', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ threadId, guideId }),
        });
        if (res.ok) {
          markCompletionPersisted(sessionId);
          // Auto-advance bootcamp phase when a bootcamp-bound guide completes
          const nextPhase = GUIDE_PHASE_ADVANCE[guideId];
          if (nextPhase) {
            advanceBootcampPhase(threadId, nextPhase, guideId);
          }
          return;
        }
        if (attempt < 3) {
          console.warn(`[Guide] Completion callback ${res.status}, retry ${attempt}…`);
          await notify(attempt + 1);
          return;
        }
        console.error(`[Guide] Completion failed after ${attempt} attempts: ${res.status}`);
        markCompletionFailed(sessionId);
        rollbackCompletedGuide(threadId, guideId);
      } catch (err) {
        if (attempt < 3) {
          console.warn('[Guide] Completion callback error, retrying…', err);
          await notify(attempt + 1);
          return;
        }
        console.error('[Guide] Completion callback failed after retries:', err);
        markCompletionFailed(sessionId);
        rollbackCompletedGuide(threadId, guideId);
      }
    };
    notify();
  }, [
    session?.phase,
    session?.flow.id,
    session?.sessionId,
    session?.threadId,
    session,
    markCompletionPersisted,
    markCompletionFailed,
  ]);
}

/**
 * PATCH to advance bootcamp phase after guide completion.
 * On success: syncs local store. On failure: rolls back completedGuides
 * so the guide can be re-triggered (prevents dead-state lockout).
 */
function advanceBootcampPhase(threadId: string, nextPhase: string, guideId: string): void {
  void (async () => {
    try {
      const freshThreadRes = await apiFetch(`/api/threads/${threadId}`);
      if (!freshThreadRes.ok) {
        rollbackCompletedGuide(threadId, guideId);
        return;
      }

      const freshThread = (await freshThreadRes.json()) as Pick<Thread, 'bootcampState'>;
      const existing = freshThread.bootcampState;
      if (!existing) {
        rollbackCompletedGuide(threadId, guideId);
        return;
      }

      const nextState = { ...existing, phase: nextPhase, guideStep: null };
      const patchRes = await apiFetch(`/api/threads/${threadId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ bootcampState: nextState }),
      });
      if (!patchRes.ok) {
        rollbackCompletedGuide(threadId, guideId);
        return;
      }

      const patchedThread = (await patchRes.json()) as Pick<Thread, 'bootcampState'>;
      syncLocalBootcampState(threadId, patchedThread.bootcampState ?? (nextState as Thread['bootcampState']));
    } catch {
      rollbackCompletedGuide(threadId, guideId);
    }
  })();
}

/** Remove a completedGuides entry so the guide can be re-triggered on failure. */
function rollbackCompletedGuide(threadId: string, guideId: string): void {
  const key = `${threadId}::${guideId}`;
  const { completedGuides } = useGuideStore.getState();
  if (!completedGuides.has(key)) return;
  const next = new Set(completedGuides);
  next.delete(key);
  useGuideStore.setState({ completedGuides: next });
}
