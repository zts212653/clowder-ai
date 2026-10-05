'use client';

/**
 * F322 original-B: the row's one 强制重置.
 *
 * The queue already projects a force_reset recovery action for a stuck message (its request is the thread's
 * force-reset endpoint), and the old execution bar posted the same endpoint for a quiet turn. The row keeps
 * both paths and lets the user press one button:
 *  - a stuck message ⇒ the projected action runs through useQueueActionConvergence, unchanged;
 *  - a quiet turn / unverified legacy turn ⇒ the thread-level request, which, unlike the old bar, checks
 *    `response.ok` (a 409/503 no longer toasts "已重置"), then re-reads the queue and the canonical executions.
 * One ForceResetDialog serves both, so the user is asked once, in the same words.
 */
import type { QueueRecoveryAction } from '@cat-cafe/shared';
import { useCallback, useState } from 'react';
import { refreshActiveExecutionProjection } from '@/hooks/useActiveExecutionProjection';
import { useActiveExecutionStore } from '@/stores/activeExecutionStore';
import { useToastStore } from '@/stores/toastStore';
import type { useQueueActionConvergence } from '../useQueueActionConvergence';
import type { ForceResetReason } from './row-model';
import { postThreadForceReset } from './thread-force-reset';

type ForceResetAction = Extract<QueueRecoveryAction, { kind: 'force_reset' }>;
type Convergence = ReturnType<typeof useQueueActionConvergence>;

export function useRowForceReset(options: {
  threadId: string;
  reasons: readonly ForceResetReason[];
  /** The projected action of the stuck message, when the queue has one. */
  stuckAction: ForceResetAction | null;
  convergence: Pick<
    Convergence,
    | 'forceResetAction'
    | 'resettingActionIds'
    | 'refreshQueue'
    | 'handleForceResetOpen'
    | 'handleForceResetCancel'
    | 'handleForceResetConfirm'
  >;
}) {
  const { threadId, reasons, stuckAction, convergence } = options;
  const [threadOpen, setThreadOpen] = useState(false);
  const [threadBusy, setThreadBusy] = useState(false);

  const request = useCallback(() => {
    if (reasons.includes('processing_stuck') && stuckAction) convergence.handleForceResetOpen(stuckAction);
    else setThreadOpen(true);
  }, [convergence, reasons, stuckAction]);

  const confirmThread = useCallback(async () => {
    const toast = useToastStore.getState().addToast;
    setThreadBusy(true);
    try {
      const result = await postThreadForceReset(threadId);
      if (!result.ok) {
        toast({ type: 'error', title: '恢复未成功', message: result.message, threadId, duration: 5000 });
        return;
      }
      // The reset itself is done. Re-reading is best effort: if it fails, the 4s projection poll and the queue's
      // own updates converge, and the reset must not be reported as failed because a re-read was.
      try {
        await convergence.refreshQueue();
        const { anchorThreadId, projectPath } = useActiveExecutionStore.getState();
        if (anchorThreadId && projectPath) await refreshActiveExecutionProjection(anchorThreadId, projectPath);
      } catch {
        // converges on the next poll
      }
      toast({ type: 'success', title: '已重置', message: '对话已解放，可以发新消息了', threadId, duration: 4000 });
      setThreadOpen(false);
    } finally {
      setThreadBusy(false);
    }
  }, [convergence, threadId]);

  const queueBusy =
    convergence.forceResetAction !== null && convergence.resettingActionIds.has(convergence.forceResetAction.id);

  return {
    request,
    dialog: {
      open: threadOpen || convergence.forceResetAction !== null,
      busy: threadBusy || queueBusy,
      onCancel: () => {
        setThreadOpen(false);
        convergence.handleForceResetCancel();
      },
      onConfirm: () => {
        if (convergence.forceResetAction) void convergence.handleForceResetConfirm();
        else void confirmThread();
      },
    },
  };
}
