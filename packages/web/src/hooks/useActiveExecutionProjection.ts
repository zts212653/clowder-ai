'use client';

import type { ActiveExecutionListResponse, ActiveExecutionProjection } from '@cat-cafe/shared';
import { useEffect } from 'react';
import { useActiveExecutionStore } from '@/stores/activeExecutionStore';
import { apiFetch } from '@/utils/api-client';

const ACTIVE_EXECUTION_REFRESH_MS = 4_000;

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

export async function refreshActiveExecutionProjection(anchorThreadId: string, signal?: AbortSignal): Promise<void> {
  const store = useActiveExecutionStore.getState();
  const requestVersion = store.beginHydration(anchorThreadId);
  try {
    const response = await apiFetch(`/api/threads/${encodeURIComponent(anchorThreadId)}/executions/active`, {
      signal,
    });
    if (!response.ok) throw new Error(`Execution hydration failed (${response.status})`);
    const body = (await response.json()) as ActiveExecutionListResponse;
    useActiveExecutionStore.getState().applySnapshot(anchorThreadId, requestVersion, body);
  } catch (error) {
    if (signal?.aborted) return;
    useActiveExecutionStore.getState().failHydration(anchorThreadId, requestVersion, error);
  }
}

export async function cancelProjectedExecution(execution: ActiveExecutionProjection): Promise<void> {
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
        : await apiFetch(`/api/callbacks/hold-ball/${encodeURIComponent(target.taskId)}`, { method: 'DELETE' });
    await requireCancelConvergence(response);
    useActiveExecutionStore.getState().settleCancellation(execution);
    const anchorThreadId = useActiveExecutionStore.getState().anchorThreadId;
    if (anchorThreadId) await refreshActiveExecutionProjection(anchorThreadId);
  } catch (error) {
    useActiveExecutionStore.getState().releaseCancellation(execution);
    throw error;
  }
}

/** Stop a legacy socket witness, then refresh and stop the canonical replacement if one appeared. */
export async function cancelUnverifiedLegacyExecution(target: {
  threadId: string;
  catId: string;
  executionId: string;
}): Promise<void> {
  const response = await postLiveExecutionCancel(target);
  await requireCancelConvergence(response);
  await refreshActiveExecutionProjection(target.threadId);
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
 * Hydrate project-wide execution truth on first mount/navigation/reconnect, then
 * poll narrowly so a background start that emitted no local socket event is
 * still discovered. The store retains the last good snapshot on transient error.
 */
export function useActiveExecutionProjection(anchorThreadId: string, socketConnected: boolean | null): void {
  useEffect(() => {
    const controller = new AbortController();
    const refresh = () => void refreshActiveExecutionProjection(anchorThreadId, controller.signal);
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
  }, [anchorThreadId]);

  useEffect(() => {
    if (socketConnected !== true) return;
    const controller = new AbortController();
    void refreshActiveExecutionProjection(anchorThreadId, controller.signal);
    return () => controller.abort();
  }, [anchorThreadId, socketConnected]);
}
