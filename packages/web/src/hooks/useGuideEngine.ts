'use client';

import { useEffect, useRef } from 'react';
import { useChatStore } from '@/stores/chatStore';
import type { OrchestrationFlow } from '@/stores/guideStore';
import { useGuideStore } from '@/stores/guideStore';
import { apiFetch } from '@/utils/api-client';

/**
 * F155: Guide Engine hook (v2 — tag-based engine)
 *
 * - Listens for guide:start CustomEvent (from InteractiveBlock callback)
 * - Fetches flow definition from API at runtime (no build-time catalog)
 * - On completion, notifies backend to transition guideState active → completed
 * - Exposes window.__startGuide for dev testing
 */
export function useGuideEngine() {
  const startGuide = useGuideStore((s) => s.startGuide);
  const advanceStep = useGuideStore((s) => s.advanceStep);
  const exitGuide = useGuideStore((s) => s.exitGuide);
  const startInFlightRef = useRef<string | null>(null);
  const pendingRetryRef = useRef<string | null>(null);
  const setPhase = useGuideStore((s) => s.setPhase);

  // Start listener: fetch flow + trigger overlay
  useEffect(() => {
    const isActiveThread = (threadId?: string) => !threadId || useChatStore.getState().currentThreadId === threadId;

    const hasActiveSession = (flowId: string, threadId?: string) => {
      const session = useGuideStore.getState().session;
      return (
        !!session &&
        session.flow.id === flowId &&
        session.threadId === (threadId ?? null) &&
        session.phase !== 'complete'
      );
    };

    const trigger = async (flowId: string, threadId?: string) => {
      const startKey = `${threadId ?? 'no-thread'}::${flowId}`;
      if (!isActiveThread(threadId)) {
        return;
      }
      if (hasActiveSession(flowId, threadId)) {
        return;
      }
      if (startInFlightRef.current === startKey) {
        pendingRetryRef.current = startKey;
        return;
      }
      startInFlightRef.current = startKey;
      try {
        const res = await apiFetch(`/api/guide-flows/${encodeURIComponent(flowId)}`);
        if (!res.ok) {
          // Don't set pendingRetryRef — that would trigger immediate self-loop via finally.
          // startInFlightRef clears in finally; next guide_start event (socket replay) can retry.
          console.error(`[Guide] Flow fetch failed (${res.status}), awaiting next guide_start event`);
          return;
        }
        const flow = (await res.json()) as OrchestrationFlow;
        if (!flow?.steps?.length) {
          console.warn(`[Guide] Empty flow: ${flowId}`);
          return;
        }
        if (!isActiveThread(threadId)) return;
        if (hasActiveSession(flowId, threadId)) return;
        startGuide(flow, threadId);
      } catch (err) {
        console.error(`[Guide] Failed to fetch flow "${flowId}":`, err);
      } finally {
        if (startInFlightRef.current === startKey) {
          startInFlightRef.current = null;
        }
        if (pendingRetryRef.current === startKey && isActiveThread(threadId) && !hasActiveSession(flowId, threadId)) {
          pendingRetryRef.current = null;
          queueMicrotask(() => {
            void trigger(flowId, threadId);
          });
        }
      }
    };

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (window as any).__startGuide = trigger;

    const handleGuideStart = (e: Event) => {
      const detail = (e as CustomEvent<{ flowId: string; threadId?: string }>).detail;
      if (detail?.flowId) trigger(detail.flowId, detail.threadId);
    };

    const handleGuideControl = (e: Event) => {
      const detail = (
        e as CustomEvent<{
          action: 'next' | 'skip' | 'exit';
          guideId?: string;
          threadId?: string;
        }>
      ).detail;
      if (!detail?.action) return;

      const session = useGuideStore.getState().session;
      if (!session) return;
      if (detail.guideId && detail.guideId !== session.flow.id) return;
      if (detail.threadId && detail.threadId !== session.threadId) return;

      switch (detail.action) {
        case 'next':
        case 'skip':
          advanceStep();
          break;
        case 'exit':
          exitGuide();
          break;
      }
    };

    const handleGuideComplete = (e: Event) => {
      const detail = (e as CustomEvent<{ guideId?: string; threadId?: string }>).detail;
      const session = useGuideStore.getState().session;
      if (!session) return;
      if (detail?.guideId && detail.guideId !== session.flow.id) return;
      if (detail?.threadId && detail.threadId !== session.threadId) return;
      setPhase('complete');
    };

    window.addEventListener('guide:start', handleGuideStart);
    window.addEventListener('guide:control', handleGuideControl);
    window.addEventListener('guide:complete', handleGuideComplete);
    return () => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      delete (window as any).__startGuide;
      window.removeEventListener('guide:start', handleGuideStart);
      window.removeEventListener('guide:control', handleGuideControl);
      window.removeEventListener('guide:complete', handleGuideComplete);
    };
  }, [advanceStep, exitGuide, setPhase, startGuide]);

  // Completion callback: when phase becomes 'complete', notify backend.
  // The overlay blocks dismiss until markCompletionPersisted() is called.
  const session = useGuideStore((s) => s.session);
  const markCompletionPersisted = useGuideStore((s) => s.markCompletionPersisted);
  const markCompletionFailed = useGuideStore((s) => s.markCompletionFailed);
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
