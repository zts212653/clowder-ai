'use client';

import type { ActiveExecutionProjection } from '@cat-cafe/shared';
import { useState } from 'react';
import { cancelProjectedExecution } from '@/hooks/useActiveExecutionProjection';
import { useToastStore } from '@/stores/toastStore';

const NON_CANCELABLE_COPY = {
  control_plane_unavailable: '控制面暂不可用，无法安全停止',
  cancellation_pending: '正在停止',
  terminalizing: '正在收尾，已不可停止',
} as const;

export function ExecutionCancelButton({
  execution,
  label = '停止',
  pendingLabel = '停止中…',
  className = 'text-xs text-cafe-muted hover:text-conn-red-text transition-colors',
}: {
  execution: ActiveExecutionProjection;
  label?: string;
  pendingLabel?: string;
  className?: string;
}) {
  const [pending, setPending] = useState(false);
  if (execution.cancelability.state === 'not_cancelable') {
    const reason = NON_CANCELABLE_COPY[execution.cancelability.reason];
    return (
      <span className="text-micro text-cafe-muted" data-testid="execution-not-cancelable" title={reason}>
        {reason}
      </span>
    );
  }

  const cancel = async () => {
    setPending(true);
    try {
      await cancelProjectedExecution(execution);
    } catch (error) {
      useToastStore.getState().addToast({
        type: 'error',
        title: '停止失败',
        message: error instanceof Error ? error.message : '请刷新后重试',
        duration: 5000,
      });
      setPending(false);
    }
  };

  return (
    <button
      type="button"
      onClick={() => void cancel()}
      disabled={pending}
      className={`${className} disabled:cursor-wait disabled:opacity-50`}
      aria-label={`Stop ${execution.catId} ${execution.kind} ${execution.executionId}`}
    >
      {pending ? pendingLabel : label}
    </button>
  );
}
