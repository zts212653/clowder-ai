'use client';

import { useCallback, useMemo, useState } from 'react';
import { activeExecutionKey, useActiveExecutionStore } from '@/stores/activeExecutionStore';
import { useToastStore } from '@/stores/toastStore';
import { cancelProjectedExecution, cancelUnverifiedLegacyExecution } from './useActiveExecutionProjection';

export type ExecutionCancelState = 'available' | 'pending' | 'unavailable';

/** Canonical live-execution targets and the shared, atomic cancel control for one thread. */
export interface LegacyExecutionCancelTarget {
  readonly executionId: string;
  readonly catId: string;
}

export function useLiveExecutionCancelControl(
  threadId: string | null,
  legacyTargets: readonly LegacyExecutionCancelTarget[] = [],
) {
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
  const [legacyCancelPending, setLegacyCancelPending] = useState(false);
  const effectiveLegacyTargets = useMemo(() => {
    if (cancelableExecutions.length > 0) return [];
    if (executions.length === 0) return legacyTargets;
    const recoverableCatIds = new Set(
      executions
        .filter(
          (execution) =>
            execution.cancelability.state === 'not_cancelable' &&
            execution.cancelability.reason === 'control_plane_unavailable',
        )
        .map((execution) => execution.catId),
    );
    return legacyTargets.filter((target) => recoverableCatIds.has(target.catId));
  }, [cancelableExecutions.length, executions, legacyTargets]);
  const pending = executions.some(
    (execution) =>
      cancelPendingByKey[activeExecutionKey(execution)] === true ||
      (execution.cancelability.state === 'not_cancelable' && execution.cancelability.reason === 'cancellation_pending'),
  );
  const state: ExecutionCancelState =
    pending || legacyCancelPending
      ? 'pending'
      : cancelableExecutions.length > 0 || effectiveLegacyTargets.length > 0
        ? 'available'
        : 'unavailable';
  const cancelAll = useCallback(async () => {
    setLegacyCancelPending(effectiveLegacyTargets.length > 0);
    const results = await Promise.allSettled(
      cancelableExecutions.length > 0
        ? cancelableExecutions.map((execution) => cancelProjectedExecution(execution))
        : effectiveLegacyTargets.map((target) =>
            threadId
              ? cancelUnverifiedLegacyExecution({ ...target, threadId })
              : Promise.reject(new Error('Missing thread identity')),
          ),
    );
    setLegacyCancelPending(false);
    const failures = results.filter((result): result is PromiseRejectedResult => result.status === 'rejected');
    if (failures.length > 0) {
      useToastStore.getState().addToast({
        type: 'error',
        title: '部分执行未能停止',
        message: '运行状态已重新同步，请按仍显示的精确执行重试。',
        duration: 5000,
      });
    }
  }, [cancelableExecutions, effectiveLegacyTargets, threadId]);

  return { executions, state, cancelAll };
}
