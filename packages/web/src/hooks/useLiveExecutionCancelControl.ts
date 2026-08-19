'use client';

import { useCallback, useMemo } from 'react';
import { activeExecutionKey, useActiveExecutionStore } from '@/stores/activeExecutionStore';
import { useToastStore } from '@/stores/toastStore';
import { cancelProjectedExecution } from './useActiveExecutionProjection';

export type ExecutionCancelState = 'available' | 'pending' | 'unavailable';

/** Canonical live-execution targets and the shared, atomic cancel control for one thread. */
export function useLiveExecutionCancelControl(threadId: string | null) {
  const executionsByKey = useActiveExecutionStore((state) => state.executionsByKey);
  const cancelPendingByKey = useActiveExecutionStore((state) => state.cancelPendingByKey);
  const executions = useMemo(
    () =>
      Object.values(executionsByKey).filter(
        (execution) => execution.threadId === threadId && execution.kind === 'live_invocation',
      ),
    [executionsByKey, threadId],
  );
  const cancelableExecutions = useMemo(
    () => executions.filter((execution) => execution.cancelability.state === 'cancelable'),
    [executions],
  );
  const pending = executions.some(
    (execution) =>
      cancelPendingByKey[activeExecutionKey(execution)] === true ||
      (execution.cancelability.state === 'not_cancelable' && execution.cancelability.reason === 'cancellation_pending'),
  );
  const state: ExecutionCancelState = pending
    ? 'pending'
    : cancelableExecutions.length > 0
      ? 'available'
      : 'unavailable';
  const cancelAll = useCallback(async () => {
    const results = await Promise.allSettled(
      cancelableExecutions.map((execution) => cancelProjectedExecution(execution)),
    );
    if (results.some((result) => result.status === 'rejected')) {
      useToastStore.getState().addToast({
        type: 'error',
        title: '部分执行未能停止',
        message: '运行状态已重新同步，请按仍显示的精确执行重试。',
        duration: 5000,
      });
    }
  }, [cancelableExecutions]);

  return { executions, state, cancelAll };
}
