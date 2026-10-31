'use client';

import type { ActiveExecutionProjection } from '@cat-cafe/shared';
import { useEffect, useRef, useState } from 'react';
import { AppTooltip } from '@/components/AppTooltip';
import { ConfirmDialog } from '@/components/ConfirmDialog';
import { ExecutionCancelButton } from '@/components/ExecutionCancelButton';
import { useShellCopy } from '@/components/shell/shell-copy';
import { cancelProjectedExecution } from '@/hooks/useActiveExecutionProjection';
import { activeExecutionKey, useActiveExecutionStore } from '@/stores/activeExecutionStore';
import { useToastStore } from '@/stores/toastStore';
import { executionDetailCopy } from './execution-detail.shell-copy';
import { workspaceV3Copy } from './workspace-v3.shell-copy';

const matches = (left: ActiveExecutionProjection, right: ActiveExecutionProjection) =>
  left.startedAt === right.startedAt &&
  left.executionId === right.executionId &&
  left.threadId === right.threadId &&
  left.catId === right.catId &&
  left.kind === right.kind &&
  left.turnInvocationId === right.turnInvocationId;

/** A confirmation never acquires permission to cancel a replacement execution. */
export function HomeExecutionStopControl({ execution, name }: { execution: ActiveExecutionProjection; name: string }) {
  const t = useShellCopy(workspaceV3Copy);
  const details = useShellCopy(executionDetailCopy);
  const returnFocus = useRef<HTMLDivElement>(null);
  const [confirmation, setConfirmation] = useState<ActiveExecutionProjection | null>(null);
  useEffect(() => {
    if (confirmation && (!matches(confirmation, execution) || execution.cancelability.state !== 'cancelable'))
      setConfirmation(null);
  }, [confirmation, execution]);
  const stop = async () => {
    const selected = confirmation;
    setConfirmation(null);
    if (!selected) return;
    const current = useActiveExecutionStore.getState().executionsByKey[activeExecutionKey(selected)];
    if (!current || !matches(selected, current) || current.cancelability.state !== 'cancelable') return;
    try {
      await cancelProjectedExecution(current);
    } catch {
      useToastStore
        .getState()
        .addToast({ type: 'error', title: details.stopFailed, message: details.stopRetry, duration: 5000 });
    }
  };
  return (
    <div ref={returnFocus} className="home-execution-stop" tabIndex={-1}>
      <AppTooltip label={details.stop} detail={t.stopNamed(name)} side="top" disabled={!!confirmation}>
        <ExecutionCancelButton
          execution={execution}
          label={<span aria-hidden="true">■</span>}
          pendingLabel={<span aria-hidden="true">…</span>}
          ariaLabel={t.stopNamed(name)}
          nonCancelableCopy={details.blocked}
          className="home-stop shell-focusable"
          onRequestCancel={() => setConfirmation(execution)}
        />
      </AppTooltip>
      <ConfirmDialog
        open={!!confirmation && matches(confirmation, execution) && execution.cancelability.state === 'cancelable'}
        title={t.confirmStopNamed(name)}
        message={t.confirmExecutionMessage}
        confirmLabel={details.stop}
        cancelLabel={details.cancel}
        variant="danger"
        returnFocusRef={returnFocus}
        onCancel={() => setConfirmation(null)}
        onConfirm={() => void stop()}
      />
    </div>
  );
}
