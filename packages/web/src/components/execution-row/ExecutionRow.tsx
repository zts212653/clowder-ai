'use client';

/**
 * F322 original-B: the one row. It replaces, once every action is proven preserved, the top "回复中" / "执行中"
 * bar, the "卡住了？强制重置" banner, the "待处理" queue panel and the "猫猫正在回复中… 取消" row. Until the mount
 * hunks land it is a standalone component: nothing renders it yet.
 *
 * The row is a fixed height and the panel overlays the conversation, so opening it never moves the chat.
 */
import { useEffect, useRef, useState } from 'react';
import { CatAvatar } from '../CatAvatar';
import { ExecutionCancelButton } from '../ExecutionCancelButton';
import { ForceResetDialog } from '../ForceResetDialog';
import { SteerQueuedEntryModal } from '../SteerQueuedEntryModal';
import { ExecutionRowPanel } from './ExecutionRowPanel';
import { FORCE_RESET_REASON_COPY, PAUSE_REASON_COPY, rowStatusText } from './row-model';
import { type ExecutionRowController, useExecutionRow } from './useExecutionRow';

const ATTENTION = new Set(['silent', 'unverified', 'stuck', 'paused']);

function Avatars({ controller }: { controller: ExecutionRowController }) {
  const { model, executions } = controller;
  if (model.single) return <CatAvatar catId={model.single.catId} size={20} />;
  const shown = executions.slice(0, 3);
  if (shown.length === 0) return null;
  return (
    <span className="flex items-center">
      {shown.map((execution, index) => (
        <span key={execution.executionId + execution.catId} className={index === 0 ? '' : '-ml-1.5'}>
          <CatAvatar catId={execution.catId} size={18} />
        </span>
      ))}
    </span>
  );
}

function Chevron({ open }: { open: boolean }) {
  return (
    <svg
      viewBox="0 0 20 20"
      aria-hidden="true"
      className={`h-3.5 w-3.5 flex-none text-cafe-muted transition-transform ${open ? 'rotate-180' : ''}`}
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="m5 8 5 5 5-5" />
    </svg>
  );
}

function Body({ controller, open }: { controller: ExecutionRowController; open: boolean }) {
  const { model, resolveCatName } = controller;
  const attention = ATTENTION.has(model.status);
  const title = model.pauseReason ? PAUSE_REASON_COPY[model.pauseReason] : undefined;
  return (
    <>
      {attention ? (
        <span
          data-testid="execution-row-dot"
          aria-hidden="true"
          className="h-2 w-2 flex-none rounded-full"
          style={{ backgroundColor: 'var(--semantic-warning)' }}
        />
      ) : (
        <Avatars controller={controller} />
      )}
      <span data-testid="execution-row-text" title={title} className="min-w-0 truncate font-medium text-cafe-secondary">
        {rowStatusText(model, resolveCatName)}
      </span>
      {model.staleNote ? (
        <span
          data-testid="execution-row-stale"
          className="flex-none text-micro text-conn-amber-text"
          title="同步暂时失败，显示最近一次已验证状态。"
        >
          状态暂不可核对
        </span>
      ) : null}
      {model.panelToggle ? <Chevron open={open} /> : null}
    </>
  );
}

export function ExecutionRow({ threadId }: { threadId: string }) {
  const controller = useExecutionRow(threadId);
  const { model, convergence, forceReset } = controller;
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const panelOpen = open && model.panelToggle;

  useEffect(() => {
    if (!panelOpen) return;
    const onKey = (event: KeyboardEvent) => event.key === 'Escape' && setOpen(false);
    const onPointer = (event: PointerEvent) => {
      if (rootRef.current && !rootRef.current.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener('keydown', onKey);
    document.addEventListener('pointerdown', onPointer);
    return () => {
      document.removeEventListener('keydown', onKey);
      document.removeEventListener('pointerdown', onPointer);
    };
  }, [panelOpen]);

  const steerEntry = convergence.steerEntryId
    ? (controller.view.queue.find((entry) => entry.id === convergence.steerEntryId) ?? null)
    : null;

  if (!model.visible) return null;

  return (
    <div ref={rootRef} data-testid="execution-row" data-status={model.status} className="relative">
      <div className="flex h-9 items-center gap-2 px-4 text-xs">
        {model.panelToggle ? (
          <button
            type="button"
            data-testid="execution-row-toggle"
            aria-expanded={panelOpen}
            onClick={() => setOpen(!panelOpen)}
            className="flex min-w-0 flex-1 items-center gap-2 text-left"
          >
            <Body controller={controller} open={panelOpen} />
          </button>
        ) : (
          <div className="flex min-w-0 flex-1 items-center gap-2">
            <Body controller={controller} open={false} />
          </div>
        )}
        {model.forceReset.length > 0 ? (
          <button
            type="button"
            data-testid="execution-row-force-reset"
            title={model.forceReset.map((reason) => FORCE_RESET_REASON_COPY[reason]).join('；')}
            onClick={forceReset.request}
            className="flex-none rounded-md px-2 py-1 font-semibold transition-opacity hover:opacity-90"
            style={{ backgroundColor: 'var(--semantic-critical-surface)', color: 'var(--semantic-critical)' }}
          >
            强制重置
          </button>
        ) : null}
        {model.resumeOnRow ? (
          <button
            type="button"
            data-testid="execution-row-resume"
            onClick={() => void controller.commands.handleContinue()}
            className="flex-none rounded-md bg-[var(--semantic-success)] px-2 py-1 text-[var(--cafe-surface)] hover:opacity-90"
          >
            {model.resumeOnRow === 'continue' ? '继续' : '恢复'}
          </button>
        ) : null}
        {model.stop.kind === 'button' ? (
          <span data-testid="execution-row-stop" className="flex-none">
            <ExecutionCancelButton execution={model.stop.execution} label="■" />
          </span>
        ) : null}
      </div>
      {panelOpen ? <ExecutionRowPanel controller={controller} /> : null}
      {steerEntry && steerEntry.status === 'queued' ? (
        <SteerQueuedEntryModal onCancel={convergence.handleSteerCancel} onConfirm={convergence.handleSteerConfirm} />
      ) : null}
      <ForceResetDialog {...forceReset.dialog} />
    </div>
  );
}
