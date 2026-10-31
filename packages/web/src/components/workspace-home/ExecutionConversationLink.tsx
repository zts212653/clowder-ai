'use client';

import type { ActiveExecutionProjection } from '@cat-cafe/shared';
import type { ReactNode } from 'react';
import { useShellCopy } from '@/components/shell/shell-copy';
import { getThreadHref, pushThreadRouteWithHistory } from '@/components/ThreadSidebar/thread-navigation';
import { activeExecutionKey, useActiveExecutionStore } from '@/stores/activeExecutionStore';
import { useChatStore } from '@/stores/chatStore';
import { useToastStore } from '@/stores/toastStore';
import { workspaceV3Copy } from './workspace-v3.shell-copy';

function stillCurrent(execution: ActiveExecutionProjection): boolean {
  const current = useActiveExecutionStore.getState().executionsByKey[activeExecutionKey(execution)];
  return (
    !!current &&
    current.startedAt === execution.startedAt &&
    current.turnInvocationId === execution.turnInvocationId &&
    current.threadId === execution.threadId &&
    current.catId === execution.catId &&
    current.kind === execution.kind
  );
}

/** Wait only for the original Chat row to mount; the execution store remains the identity owner. */
export function focusExecutionConversation(execution: ActiveExecutionProjection): Promise<boolean> {
  return new Promise((resolve) => {
    const pending: { observer?: MutationObserver; timer?: ReturnType<typeof setTimeout> } = {};
    const finish = (found: boolean) => {
      pending.observer?.disconnect();
      clearTimeout(pending.timer);
      resolve(found);
    };
    const locate = () => {
      if (!stillCurrent(execution) || window.location.pathname !== getThreadHref(execution.threadId)) {
        finish(false);
        return true;
      }
      if (useChatStore.getState().currentThreadId !== execution.threadId) return false;
      const rows = document.querySelectorAll<HTMLElement>('[data-testid="execution-row"]');
      const row = [...rows].find(
        (item) =>
          item.dataset.executionThreadId === execution.threadId &&
          JSON.parse(item.dataset.executionKeys ?? '[]').includes(activeExecutionKey(execution)),
      );
      if (!row) return false;
      row.focus({ preventScroll: true });
      finish(true);
      return true;
    };
    if (locate()) return;
    pending.observer = new MutationObserver(locate);
    pending.observer.observe(document.body, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['data-execution-thread-id', 'data-execution-keys'],
    });
    pending.timer = setTimeout(() => finish(false), 8000);
  });
}

export function ExecutionConversationLink({
  execution,
  children,
}: {
  execution: ActiveExecutionProjection;
  children: ReactNode;
}) {
  const t = useShellCopy(workspaceV3Copy);
  const unavailable = () =>
    useToastStore.getState().addToast({ type: 'info', title: t.now, message: t.unavailableExecution, duration: 5000 });
  return (
    <a
      href={getThreadHref(execution.threadId)}
      className="home-live-main home-live-link shell-focusable"
      data-testid="workspace-open-running-object"
      onClick={(event) => {
        if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
        event.preventDefault();
        if (!stillCurrent(execution) || useChatStore.getState().presentationLock) {
          unavailable();
          return;
        }
        pushThreadRouteWithHistory(execution.threadId, window);
        useChatStore.getState().closeRightPanel();
        void focusExecutionConversation(execution).then((found) => {
          if (!found) unavailable();
        });
      }}
    >
      {children}
    </a>
  );
}
