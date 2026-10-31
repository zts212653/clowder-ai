'use client';

import type { ActiveExecutionProjection } from '@cat-cafe/shared';
import type { ReactNode } from 'react';
import { cancelProjectedExecution } from '@/hooks/useActiveExecutionProjection';
import { activeExecutionKey, useActiveExecutionStore } from '@/stores/activeExecutionStore';
import { useToastStore } from '@/stores/toastStore';

const NON_CANCELABLE_COPY = {
  control_plane_unavailable: '控制面暂不可用，无法安全停止',
  cancellation_pending: '正在停止',
  terminalizing: '正在收尾，已不可停止',
  foreign_principal: '由排程发起，占用中；你不是发起方',
} as const;

export function ExecutionCancelButton({
  execution,
  label = '停止',
  pendingLabel = '停止中…',
  ariaLabel,
  onRequestCancel,
  nonCancelableCopy = NON_CANCELABLE_COPY,
  className = 'text-xs text-cafe-muted hover:text-conn-red-text transition-colors',
}: {
  execution: ActiveExecutionProjection;
  label?: ReactNode;
  pendingLabel?: ReactNode;
  ariaLabel?: string;
  onRequestCancel?: () => void;
  nonCancelableCopy?: Record<keyof typeof NON_CANCELABLE_COPY, string>;
  className?: string;
}) {
  const pending = useActiveExecutionStore((state) => state.cancelPendingByKey[activeExecutionKey(execution)] === true);
  if (pending) {
    return (
      <button
        type="button"
        disabled
        className={`${className} cursor-wait opacity-50`}
        aria-label={ariaLabel ?? `Stop ${execution.catId} ${execution.kind} ${execution.executionId}`}
      >
        {pendingLabel}
      </button>
    );
  }
  if (execution.cancelability.state === 'not_cancelable') {
    const reason = nonCancelableCopy[execution.cancelability.reason];
    return (
      <span className="text-micro text-cafe-muted" data-testid="execution-not-cancelable" title={reason}>
        {reason}
      </span>
    );
  }

  const cancel = async () => {
    try {
      await cancelProjectedExecution(execution);
    } catch (error) {
      useToastStore.getState().addToast({
        type: 'error',
        title: '停止失败',
        message: error instanceof Error ? error.message : '请刷新后重试',
        duration: 5000,
      });
    }
  };

  return (
    <button
      type="button"
      onClick={onRequestCancel ?? (() => void cancel())}
      className={className}
      aria-label={ariaLabel ?? `Stop ${execution.catId} ${execution.kind} ${execution.executionId}`}
    >
      {label}
    </button>
  );
}
