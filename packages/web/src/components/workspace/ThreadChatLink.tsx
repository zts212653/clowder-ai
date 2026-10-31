'use client';

import type { ReactNode } from 'react';
import { getThreadHref, pushThreadRouteWithHistory } from '@/components/ThreadSidebar/thread-navigation';
import { useChatStore } from '@/stores/chatStore';

const CLASSIC_CLASS_NAME =
  'shrink-0 rounded-lg border border-cafe-subtle px-2.5 py-1 text-micro font-semibold text-cafe-secondary transition-colors hover:bg-cafe-surface hover:text-cafe';

/**
 * Open the owning Chat even when its running-work evidence is unavailable.
 *
 * `label` / `className` / `title` let the new shell's Workspace home draw its own link; with none given this renders
 * exactly what it always did (the classic home).
 */
export function ThreadChatLink({
  threadId,
  label = 'Chat',
  children,
  className = CLASSIC_CLASS_NAME,
  title = children ? undefined : '前往这件工作的对话',
}: {
  threadId: string;
  label?: string;
  children?: ReactNode;
  className?: string;
  title?: string;
}) {
  return (
    <a
      href={getThreadHref(threadId)}
      onClick={(event) => {
        if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
        event.preventDefault();
        pushThreadRouteWithHistory(threadId, window);
        useChatStore.getState().closeRightPanel();
      }}
      className={className}
      title={title}
    >
      {children ?? label}
    </a>
  );
}
