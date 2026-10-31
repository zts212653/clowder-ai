'use client';

import type { ActiveExecutionProjection } from '@cat-cafe/shared';
import { useEffect, useSyncExternalStore } from 'react';
import { activeExecutionKey } from '@/stores/activeExecutionStore';
import { useChatStore } from '@/stores/chatStore';

export interface ExecutionDetailRequest {
  readonly hostThreadId: string;
  readonly executionKey: string;
  readonly revision: number;
  readonly identity: Pick<ActiveExecutionProjection, 'kind' | 'executionId' | 'catId' | 'threadId' | 'startedAt'>;
}
let request: ExecutionDetailRequest | null = null;
let revision = 0;
let originFocus: HTMLElement | null = null;
const listeners = new Set<() => void>();
function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
function getSnapshot() {
  return request;
}

/** A transient navigation coordinate only. The execution and command remain in their original stores. */
export function requestExecutionDetail(execution: ActiveExecutionProjection): void {
  const chat = useChatStore.getState();
  if (chat.presentationLock) return;
  originFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  request = {
    hostThreadId: chat.currentThreadId,
    executionKey: activeExecutionKey(execution),
    revision: ++revision,
    identity: {
      kind: execution.kind,
      executionId: execution.executionId,
      catId: execution.catId,
      threadId: execution.threadId,
      startedAt: execution.startedAt,
    },
  };
  // Open the original panel before relying on its Home hook: a closed Workspace has no mounted consumer yet.
  chat.setWorkspaceMode('dev');
  chat.setRightPanelMode('workspace');
  chat.setRightPanelOpen(true);
  for (const listener of listeners) listener();
}
export function clearExecutionDetailRequest(): void {
  request = null;
  for (const listener of listeners) listener();
  if (originFocus?.isConnected) originFocus.focus({ preventScroll: true });
  originFocus = null;
}
export function useExecutionDetailRequest(): ExecutionDetailRequest | null {
  return useSyncExternalStore(subscribe, getSnapshot, () => null);
}

/** C's existing Home host calls this with its own setHomeOpen; B never edits the host or creates a Home topology node. */
export function useWorkspaceExecutionRequest(threadId: string | undefined, setHomeOpen: (open: boolean) => void): void {
  const target = useExecutionDetailRequest();
  useEffect(() => {
    if (!target || target.hostThreadId !== threadId) return;
    const chat = useChatStore.getState();
    if (chat.presentationLock) return;
    setHomeOpen(true);
  }, [target, threadId, setHomeOpen]);
}
