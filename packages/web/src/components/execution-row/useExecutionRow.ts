'use client';

/**
 * F322 original-B: the adapter between the app's existing authorities and the one-row surface.
 *
 * It owns no store. It reads the canonical execution projection (activeExecutionStore), the thread's liveness,
 * the legacy-vs-canonical verification and the queue (via useQueueView), hands them to the pure row model, and
 * wires the row's buttons to the very same commands the old surfaces use (cancelProjectedExecution through
 * ExecutionCancelButton, useQueueCommands, useQueueActionConvergence). The 1s clock ticks only while something runs.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useCatData } from '@/hooks/useCatData';
import { useExecutionRecoveryVerification } from '@/hooks/useExecutionRecoveryVerification';
import { useThreadLiveness } from '@/hooks/useThreadScopedSelectors';
import { resolveCatNameplateName } from '@/lib/cat-display-name';
import { activeExecutionKey, useActiveExecutionStore } from '@/stores/activeExecutionStore';
import { useToastStore } from '@/stores/toastStore';
import { isStreamingTipSuppressed } from '../capability-tip-placement';
import { useShellCopy } from '../shell/shell-copy';
import { useMessageNavigation } from '../thread-chat/MessageNavigationContext';
import { useQueueActionConvergence } from '../useQueueActionConvergence';
import { locateExecution } from './execution-location';
import { executionRowCopy } from './execution-row.shell-copy';
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

export function useExecutionRow(threadId: string) {
  const navigateToMessage = useMessageNavigation();
  const words = useShellCopy(executionRowCopy);
  const { getCatById } = useCatData({ fetch: false });
  const resolveCatName = useCallback((catId: string) => resolveCatNameplateName(catId, getCatById), [getCatById]);
  const { catInvocations, catStatuses } = useThreadLiveness(threadId);
  const executionsByKey = useActiveExecutionStore((state) => state.executionsByKey);
  const cancelPendingByKey = useActiveExecutionStore((state) => state.cancelPendingByKey);
  // The ONE shared answer to "is what this thread shows still verified?": the project-wide snapshot covers this thread
  // when it is anchored here OR belongs to the same project, so a failed re-read is stale for a same-project thread
  // that is not the anchor too. (An anchor-only test here missed that case; the classic composer already gets it right.)
  const { canonicalProjectionStale, canonicalProjectionLoading, hasUnverifiedLegacyExecution } =
    useExecutionRecoveryVerification(threadId);
  const [confirmationExpired, setConfirmationExpired] = useState(false);
  useEffect(() => {
    setConfirmationExpired(false);
    if (!canonicalProjectionLoading || !hasUnverifiedLegacyExecution) return;
    const timer = setTimeout(() => setConfirmationExpired(true), 10_000);
    return () => clearTimeout(timer);
  }, [threadId, canonicalProjectionLoading, hasUnverifiedLegacyExecution]);

  const view = useQueueView(threadId);
  // The new shell's row reports a reset that went through as done even when the re-read after it fails.
  const convergence = useQueueActionConvergence(threadId);
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
        hydrationLoading: canonicalProjectionLoading && !confirmationExpired,
        hasUnverifiedLegacyExecution,
        queue: {
          entries: view.visibleEntries,
          canRecoverOrphaned: view.canRecoverOrphanedQueue,
          waitInfo: view.waitInfo,
        },
      }),
    [
      canonicalProjectionStale,
      canonicalProjectionLoading,
      confirmationExpired,
      cancelPendingKeys,
      executions,
      hasUnverifiedLegacyExecution,
      now,
      silent,
      view,
    ],
  );

  const forceReset = useRowForceReset({ threadId, convergence });
  const locate = (execution: (typeof executions)[number]) => {
    if (locateExecution(execution, navigateToMessage) === 'unavailable')
      useToastStore
        .getState()
        .addToast({ type: 'info', title: words.actions.locate, message: words.actions.unavailable, duration: 5000 });
  };
  return { model, executions, now, silent, view, convergence, commands, forceReset, resolveCatName, locate };
}

export type ExecutionRowController = ReturnType<typeof useExecutionRow>;
