'use client';

/**
 * F322 original-B: the adapter between the app's existing authorities and the one-row surface.
 *
 * It owns no store. It reads the canonical execution projection (activeExecutionStore), the thread's liveness,
 * the legacy-vs-canonical verification and the queue (via useQueueView), hands them to the pure row model, and
 * wires the row's buttons to the very same commands the old surfaces use (cancelProjectedExecution through
 * ExecutionCancelButton, useQueueCommands, useQueueActionConvergence). The 1s clock ticks only while something runs.
 */
import type { QueueRecoveryAction } from '@cat-cafe/shared';
import { useEffect, useMemo, useState } from 'react';
import { useCatNameResolver } from '@/hooks/useCatNameResolver';
import { useExecutionRecoveryVerification } from '@/hooks/useExecutionRecoveryVerification';
import { useThreadLiveness } from '@/hooks/useThreadScopedSelectors';
import { activeExecutionKey, useActiveExecutionStore } from '@/stores/activeExecutionStore';
import { isStreamingTipSuppressed } from '../capability-tip-placement';
import { useQueueActionConvergence } from '../useQueueActionConvergence';
import { deriveExecutionRow } from './row-model';
import { useQueueCommands } from './useQueueCommands';
import { useQueueView } from './useQueueView';
import { useRowForceReset } from './useRowForceReset';

function useNow(active: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    setNow(Date.now());
    const interval = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(interval);
  }, [active]);
  return now;
}

type ForceResetAction = Extract<QueueRecoveryAction, { kind: 'force_reset' }>;

export function useExecutionRow(threadId: string) {
  const resolveCatName = useCatNameResolver();
  const { catInvocations, catStatuses } = useThreadLiveness(threadId);
  const executionsByKey = useActiveExecutionStore((state) => state.executionsByKey);
  const cancelPendingByKey = useActiveExecutionStore((state) => state.cancelPendingByKey);
  // The ONE shared answer to "is what this thread shows still verified?": the project-wide snapshot covers this thread
  // when it is anchored here OR belongs to the same project, so a failed re-read is stale for a same-project thread
  // that is not the anchor too. (An anchor-only test here missed that case; the classic composer already gets it right.)
  const { canonicalProjectionStale, hasUnverifiedLegacyExecution } = useExecutionRecoveryVerification(threadId);

  const view = useQueueView(threadId);
  // The new shell's row reports a reset that went through as done even when the re-read after it fails.
  const convergence = useQueueActionConvergence(threadId, { resetDoneSurvivesRereadFailure: true });
  const commands = useQueueCommands(threadId, view, convergence.refreshQueue);

  const executions = useMemo(
    () => Object.values(executionsByKey).filter((execution) => execution.threadId === threadId),
    [executionsByKey, threadId],
  );
  const now = useNow(executions.length > 0);

  const cancelPendingKeys = useMemo(() => new Set(Object.keys(cancelPendingByKey)), [cancelPendingByKey]);
  // The same "went quiet" test the old bar used (status or app-server lifecycle), on live turns only.
  const silent = useMemo(() => {
    const quiet: Record<string, { since: number | null }> = {};
    for (const execution of executions) {
      if (execution.kind !== 'live_invocation') continue;
      const lifecycle = catInvocations[execution.catId]?.appServerLifecycle;
      if (!isStreamingTipSuppressed(catStatuses[execution.catId], lifecycle, now)) continue;
      const known = lifecycle && (lifecycle.stage === 'turn_accepted' || lifecycle.stage === 'active');
      quiet[activeExecutionKey(execution)] = { since: known ? lifecycle.lastActivityAt : null };
    }
    return quiet;
  }, [catInvocations, catStatuses, executions, now]);

  const model = useMemo(
    () =>
      deriveExecutionRow({
        now,
        executions,
        cancelPendingKeys,
        silent,
        hydrationStale: canonicalProjectionStale,
        hasUnverifiedLegacyExecution,
        queue: {
          total: view.queue.length,
          paused: view.queuePaused,
          pauseReason: view.queuePauseReason,
          entries: view.visibleEntries,
          canRecoverOrphaned: view.canRecoverOrphanedQueue,
          waitInfo: view.waitInfo,
        },
      }),
    [canonicalProjectionStale, cancelPendingKeys, executions, hasUnverifiedLegacyExecution, now, silent, view],
  );

  const stuckAction = useMemo(
    () =>
      view.visibleEntries
        .filter((entry) => entry.status === 'processing')
        .flatMap((entry) => entry.recoveryActions ?? [])
        .find((action): action is ForceResetAction => action.kind === 'force_reset') ?? null,
    [view.visibleEntries],
  );
  const forceReset = useRowForceReset({ threadId, reasons: model.forceReset, stuckAction, convergence });

  return { model, executions, now, silent, view, convergence, commands, forceReset, resolveCatName };
}

export type ExecutionRowController = ReturnType<typeof useExecutionRow>;
