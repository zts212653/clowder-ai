'use client';

/**
 * F322 original-B: the row's one 强制重置.
 *
 * One thread-level request recovers a quiet or unverified execution. Its acknowledged
 * result owns the outcome; subsequent Queue and execution refreshes only reconcile presentation.
 */
import { useCallback, useState } from 'react';
import { refreshActiveExecutionProjection } from '@/hooks/useActiveExecutionProjection';
import { useActiveExecutionStore } from '@/stores/activeExecutionStore';
import { useToastStore } from '@/stores/toastStore';
import type { useQueueActionConvergence } from '../useQueueActionConvergence';
import { postThreadForceReset } from './thread-force-reset';

type Convergence = ReturnType<typeof useQueueActionConvergence>;

export function useRowForceReset(options: { threadId: string; convergence: Pick<Convergence, 'refreshQueue'> }) {
  const { threadId, convergence } = options;
  const [threadOpen, setThreadOpen] = useState(false);
  const [threadBusy, setThreadBusy] = useState(false);
  const request = useCallback(() => setThreadOpen(true), []);

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

  return {
    request,
    dialog: {
      open: threadOpen,
      busy: threadBusy,
      onCancel: () => setThreadOpen(false),
      onConfirm: () => void confirmThread(),
    },
  };
}
