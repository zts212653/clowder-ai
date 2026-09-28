'use client';

import { getThreadHref, pushThreadRouteWithHistory } from '@/components/ThreadSidebar/thread-navigation';
import { useChatStore } from '@/stores/chatStore';

/** Open the owning Chat even when its running-work evidence is unavailable. */
export function ThreadChatLink({ threadId }: { threadId: string }) {
  return (
    <a
      href={getThreadHref(threadId)}
      onClick={(event) => {
        if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
        event.preventDefault();
        pushThreadRouteWithHistory(threadId, window);
        useChatStore.getState().closeRightPanel();
      }}
      className="shrink-0 rounded-lg border border-cafe-subtle px-2.5 py-1 text-micro font-semibold text-cafe-secondary transition-colors hover:bg-cafe-surface hover:text-cafe"
      title="前往这件工作的对话"
    >
      Chat
    </a>
  );
}
