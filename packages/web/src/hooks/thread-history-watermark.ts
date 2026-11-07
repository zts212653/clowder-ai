import { useEffect } from 'react';
import { useChatStore } from '@/stores/chatStore';
import { apiFetch } from '@/utils/api-client';

// This is evidence of an applied History page, never of an observed socket event.
const appliedWatermarks = new Map<string, string | null>();

export function acknowledgeThreadHistoryWatermark(threadId: string, watermark: unknown): void {
  if (watermark === null || typeof watermark === 'string') appliedWatermarks.set(threadId, watermark);
}

/** Quiet final replies need a discovery signal even when every push was missed. */
export function useThreadHistoryReconciliation(foregroundRoomsKey: string): void {
  useEffect(() => {
    const threadIds = [...new Set(foregroundRoomsKey.split('\0').filter(Boolean))];
    const controller = new AbortController();
    const inFlight = new Set<string>();
    const probe = () => {
      if (document.visibilityState !== 'visible') return;
      threadIds.forEach((threadId) => {
        if (!appliedWatermarks.has(threadId)) return;
        const thread = useChatStore.getState().getThreadState(threadId);
        if (
          inFlight.has(threadId) ||
          thread.isLoadingHistory ||
          thread.hasActiveInvocation ||
          (thread.intentMode === 'execute' && thread.targetCats.length > 0) ||
          Object.values(thread.catStatuses).some((status) =>
            ['spawning', 'pending', 'streaming', 'alive_but_silent', 'suspected_stall'].includes(status),
          ) ||
          thread.messages.some((message) => message.isStreaming)
        )
          return;
        inFlight.add(threadId);
        void apiFetch(`/api/threads/${encodeURIComponent(threadId)}/watermark`, { signal: controller.signal })
          .then(async (response) => {
            if (!response.ok) return;
            const data = (await response.json()) as { watermark?: unknown };
            const watermark = data.watermark;
            if (controller.signal.aborted || (watermark !== null && typeof watermark !== 'string')) return;
            if (appliedWatermarks.get(threadId) !== watermark) {
              useChatStore.getState().requestStreamCatchUp(threadId);
            }
          })
          .catch(() => {
            // A failed probe confirms nothing; the next visible tick retries.
          })
          .finally(() => inFlight.delete(threadId));
      });
    };
    probe();
    const timer = setInterval(probe, 30_000);
    return () => {
      controller.abort();
      clearInterval(timer);
    };
  }, [foregroundRoomsKey]);
}
