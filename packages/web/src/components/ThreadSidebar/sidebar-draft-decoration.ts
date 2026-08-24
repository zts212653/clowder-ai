import { useCallback } from 'react';
import { useChatStore } from '@/stores/chatStore';

/** The sole named legacy decoration allowed into a Sidebar row. */
export function useSidebarDraftDecoration(threadId: string): boolean {
  return useChatStore(useCallback((state) => state.threadStates[threadId]?.hasDraft === true, [threadId]));
}
