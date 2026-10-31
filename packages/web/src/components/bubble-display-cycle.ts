'use client';

import { useCallback, useRef } from 'react';
import { useChatStore } from '@/stores/chatStore';
import { apiFetch } from '@/utils/api-client';

/**
 * The thread-level three-state display override ("global" → expanded → collapsed → "global") shared by the classic toggle in the
 * status panel and the new shell's "执行记录" row. Same store field, same PATCH, same optimistic rollback — only the words differ.
 */
export type BubbleDisplayField = 'bubbleThinking' | 'bubbleCli';
export type BubbleOverrideState = 'global' | 'expanded' | 'collapsed';

const BUBBLE_CYCLE: Record<BubbleOverrideState, BubbleOverrideState> = {
  global: 'expanded',
  expanded: 'collapsed',
  collapsed: 'global',
};

export function useBubbleDisplayCycle(threadId: string, field: BubbleDisplayField) {
  const thread = useChatStore((s) => s.threads.find((t) => t.id === threadId));
  const isLoadingThreads = useChatStore((s) => s.isLoadingThreads);
  const updateLocal = useChatStore((s) => s.updateThreadBubbleDisplay);
  const globalBubbleDefaults = useChatStore((s) => s.globalBubbleDefaults);
  const restorePending = isLoadingThreads && !thread;
  const current: BubbleOverrideState = thread?.[field] ?? 'global';
  const currentEffective: 'expanded' | 'collapsed' =
    current === 'global'
      ? field === 'bubbleThinking'
        ? globalBubbleDefaults.thinking
        : globalBubbleDefaults.cliOutput
      : current;
  const next: BubbleOverrideState | null = restorePending
    ? null
    : current === 'global'
      ? currentEffective === 'expanded'
        ? 'collapsed'
        : 'expanded'
      : BUBBLE_CYCLE[current];
  const pendingRef = useRef(false);

  const cycle = useCallback(async () => {
    if (pendingRef.current || restorePending || !next) return;
    pendingRef.current = true;
    updateLocal(threadId, field, next);
    try {
      const res = await apiFetch(`/api/threads/${threadId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ [field]: next }),
      });
      if (!res.ok) updateLocal(threadId, field, current);
    } catch {
      updateLocal(threadId, field, current);
    } finally {
      pendingRef.current = false;
    }
  }, [threadId, field, next, current, updateLocal, restorePending]);

  return { current, currentEffective, next, restorePending, cycle };
}
