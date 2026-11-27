'use client';

import type {
  ActiveExecutionListResponse,
  ActiveExecutionProjection,
  ActiveHoldWaitProjection,
} from '@cat-cafe/shared';
import { useEffect, useLayoutEffect, useRef } from 'react';
import { useActiveExecutionStore } from '@/stores/activeExecutionStore';
import { useChatStore } from '@/stores/chatStore';
import { useSidebarProjectionStore } from '@/stores/sidebarProjectionStore';
import { apiFetch } from '@/utils/api-client';
import { invalidateSidebarProjection } from '@/utils/sidebar-thread-snapshot';

const ACTIVE_EXECUTION_REFRESH_MS = 4_000;

function activeExecutionResource(): string {
  return '/api/executions/active?scope=all';
}

async function postLiveExecutionCancel(target: {
  threadId: string;
  catId: string;
  executionId: string;
}): Promise<Response> {
  return apiFetch(
    `/api/threads/${encodeURIComponent(target.threadId)}/executions/live/${encodeURIComponent(target.executionId)}/cancel`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ catId: target.catId }),
    },
  );
}

async function requireCancelConvergence(response: Response): Promise<void> {
  if (response.ok || response.status === 409) return;
  const detail = (await response.json().catch(() => null)) as { error?: string; code?: string } | null;
  throw new Error(detail?.error ?? `Cancel failed (${response.status})`);
}

export async function refreshActiveExecutionProjection(
  anchorThreadId: string,
  projectPath: string | null,
  signal?: AbortSignal,
): Promise<void> {
  const store = useActiveExecutionStore.getState();
  const requestVersion = store.beginHydration(anchorThreadId, projectPath);
  try {
    const response = await apiFetch(activeExecutionResource(), {
      signal,
    });
    if (!response.ok) throw new Error(`Execution hydration failed (${response.status})`);
    const body = (await response.json()) as ActiveExecutionListResponse;
    const previous = useActiveExecutionStore.getState();
    previous.applySnapshot(anchorThreadId, requestVersion, body);
    const current = useActiveExecutionStore.getState();
    const before = previous.executionsByKey;
    const after = current.executionsByKey;
    if (
      before !== after &&
      [...Object.keys(before), ...Object.keys(after)].some(
        (key) => (before[key]?.phase === 'finalizing') !== (after[key]?.phase === 'finalizing'),
      )
    )
      void invalidateSidebarProjection().catch(() => {});
  } catch (error) {
    if (signal?.aborted) return;
    useActiveExecutionStore.getState().failHydration(anchorThreadId, requestVersion, error);
  }
}

/**
 * DELETE a hold-ball task; withFeedback also tells the member why. When the task is already gone (404) and feedback
 * was asked for, the feedback is posted on its own, as the hold card always did.
 */
async function deleteHold(taskId: string, owner: { threadId: string; catId: string }, withFeedback: boolean) {
  const response = await apiFetch(
    `/api/callbacks/hold-ball/${encodeURIComponent(taskId)}${withFeedback ? '?withFeedback=1' : ''}`,
    { method: 'DELETE' },
  );
  if (response.status !== 404 || !withFeedback) return response;
  return apiFetch('/api/callbacks/hold-ball/feedback', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ threadId: owner.threadId, taskId, catId: owner.catId }),
  });
}

export async function cancelProjectedExecution(
  execution: ActiveExecutionProjection,
  withFeedback = false,
): Promise<void> {
  if (execution.cancelability.state !== 'cancelable') {
    throw new Error('This execution is not cancelable');
  }
  const executionStore = useActiveExecutionStore.getState();
  if (!executionStore.beginCancellation(execution)) return;
  const target = execution.cancelability.target;
  try {
    const response =
      target.kind === 'live_invocation'
        ? await postLiveExecutionCancel(target)
        : await deleteHold(target.taskId, execution, withFeedback);
    await requireCancelConvergence(response);
    if (response.status !== 202) useActiveExecutionStore.getState().settleCancellation(execution);
    const { anchorThreadId, projectPath } = useActiveExecutionStore.getState();
    try {
      if (anchorThreadId) await refreshActiveExecutionProjection(anchorThreadId, projectPath);
    } finally {
      if (response.status === 202) useActiveExecutionStore.getState().releaseCancellation(execution);
    }
  } catch (error) {
    useActiveExecutionStore.getState().releaseCancellation(execution);
    throw error;
  }
}

/**
 * Cancel a held ball through the same DELETE the hold card uses. A 404 means the hold already ended (fired,
 * replaced or cancelled elsewhere), which is the state the user asked for. Returns whether the hold is gone.
 */
export async function cancelHoldWait(wait: ActiveHoldWaitProjection, withFeedback = false): Promise<boolean> {
  if (wait.cancelability.state !== 'cancelable') return false;
  const response = await deleteHold(wait.cancelability.target.taskId, wait, withFeedback);
  if (!response.ok && response.status !== 404) return false;
  const store = useActiveExecutionStore.getState();
  store.settleWaitCancellation(wait.waitId);
  if (store.anchorThreadId) await refreshActiveExecutionProjection(store.anchorThreadId, store.projectPath);
  return true;
}

/** Stop a legacy socket witness, then refresh and stop the canonical replacement if one appeared. */
export async function cancelUnverifiedLegacyExecution(target: {
  threadId: string;
  catId: string;
  executionId: string;
}): Promise<void> {
  const response = await postLiveExecutionCancel(target);
  await requireCancelConvergence(response);
  const projectPath = useActiveExecutionStore.getState().projectPath;
  await refreshActiveExecutionProjection(target.threadId, projectPath);
  const replacement = Object.values(useActiveExecutionStore.getState().executionsByKey).find(
    (execution) =>
      execution.threadId === target.threadId &&
      execution.catId === target.catId &&
      execution.kind === 'live_invocation' &&
      execution.cancelability.state === 'cancelable',
  );
  if (response.status === 409 && replacement) await cancelProjectedExecution(replacement);
}

/**
 * Hydrate all readable projects through one execution resource on first mount/navigation/reconnect, then
 * poll narrowly so a background start that emitted no local socket event is
 * still discovered. The store retains the last good snapshot on transient error.
 */
export function useActiveExecutionProjection(
  anchorThreadId: string,
  socketConnected: boolean | null,
  needed: boolean | number = true,
): void {
  const canonicalProjectPath = useSidebarProjectionStore(
    (state) => state.rows.find((row) => row.id === anchorThreadId)?.projectPath,
  );
  const compatibilityProjectPath = useChatStore(
    (state) => state.threads.find((thread) => thread.id === anchorThreadId)?.projectPath,
  );
  const projectPath = canonicalProjectPath ?? compatibilityProjectPath ?? null;

  const current = useRef({ anchorThreadId, projectPath });
  current.current = { anchorThreadId, projectPath };
  useLayoutEffect(() => {
    if (!needed) return;
    const controller = new AbortController();
    const refresh = () => {
      if (!document.hidden)
        void refreshActiveExecutionProjection(
          current.current.anchorThreadId,
          current.current.projectPath,
          controller.signal,
        );
    };
    refresh();
    const interval = window.setInterval(refresh, ACTIVE_EXECUTION_REFRESH_MS);
    const refreshWhenVisible = () => {
      if (document.visibilityState === 'visible') refresh();
    };
    window.addEventListener('online', refresh);
    document.addEventListener('visibilitychange', refreshWhenVisible);
    return () => {
      controller.abort();
      window.clearInterval(interval);
      window.removeEventListener('online', refresh);
      document.removeEventListener('visibilitychange', refreshWhenVisible);
    };
  }, [needed]);

  useEffect(() => {
    if (!needed || socketConnected !== true) return;
    const controller = new AbortController();
    void refreshActiveExecutionProjection(
      current.current.anchorThreadId,
      current.current.projectPath,
      controller.signal,
    );
    return () => controller.abort();
  }, [needed, socketConnected]);
}
