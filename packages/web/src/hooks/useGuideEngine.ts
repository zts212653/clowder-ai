'use client';

import { useEffect, useRef } from 'react';
import { useChatStore } from '@/stores/chatStore';
import type { OrchestrationFlow } from '@/stores/guideStore';
import { useGuideStore } from '@/stores/guideStore';
import { apiFetch } from '@/utils/api-client';

/**
 * F155/B-5: Guide Engine hook — Zustand-driven (no CustomEvent bridge).
 *
 * Subscribes to guideStore.pendingStart (set by Socket.io → reduceServerEvent).
 * Fetches flow definition from API, then calls startGuide().
 * On completion, notifies backend to transition guideState active → completed.
 */
export function useGuideEngine() {
  const currentThreadId = useChatStore((s) => s.currentThreadId);
  const startGuide = useGuideStore((s) => s.startGuide);
  const clearPendingStart = useGuideStore((s) => s.clearPendingStart);
  const exitGuide = useGuideStore((s) => s.exitGuide);
  const startInFlightRef = useRef<string | null>(null);
  const pendingRetryRef = useRef<string | null>(null);

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
      if (startInFlightRef.current === startKey) {
        pendingRetryRef.current = startKey;
        return;
      }
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
        startGuide(flow, threadId);
      } catch (err) {
        console.error(`[Guide] Failed to fetch flow "${guideId}":`, err);
      } finally {
        if (startInFlightRef.current === startKey) {
          startInFlightRef.current = null;
        }
        if (pendingRetryRef.current === startKey && isActiveThread() && !hasActiveSession()) {
          pendingRetryRef.current = null;
          queueMicrotask(() => {
            void trigger();
          });
        }
      }
    };
    trigger();
  }, [pendingStart, startGuide, clearPendingStart]);

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
          return;
        }
        if (attempt < 3) {
          console.warn(`[Guide] Completion callback ${res.status}, retry ${attempt}…`);
          await notify(attempt + 1);
          return;
        }
        console.error(`[Guide] Completion failed after ${attempt} attempts: ${res.status}`);
        markCompletionFailed(sessionId);
      } catch (err) {
        if (attempt < 3) {
          console.warn('[Guide] Completion callback error, retrying…', err);
          await notify(attempt + 1);
          return;
        }
        console.error('[Guide] Completion callback failed after retries:', err);
        markCompletionFailed(sessionId);
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
