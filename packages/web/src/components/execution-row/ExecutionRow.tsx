'use client';

/**
 * F322 original-B: the one row. It replaces, once every action is proven preserved, the top "回复中" / "执行中"
 * bar, the "卡住了？强制重置" banner, the "待处理" queue panel and the "猫猫正在回复中… 取消" row. It is mounted
 * only by ThreadExecutionLayer in v2; classic keeps the original surfaces.
 *
 * The row is a fixed height and the panel overlays the conversation, so opening it never moves the chat.
 */
import { useEffect, useRef, useState } from 'react';
import { activeExecutionKey } from '@/stores/activeExecutionStore';
import { CatAvatar } from '../CatAvatar';
import { ForceResetDialog } from '../ForceResetDialog';
import { QueueSteerDialog } from '../QueueSteerDialog';
import { useShellCopy } from '../shell/shell-copy';
import styles from './ExecutionRow.module.css';
import { ExecutionRowActions } from './ExecutionRowActions';
import { ExecutionRowPanel } from './ExecutionRowPanel';
import { type ExecutionRowWords, executionRowCopy } from './execution-row.shell-copy';
import {
  type ExecutionRowTone,
  executionRowTone,
  executionRowToneColor,
  executionRowToneSurface,
} from './execution-row-presentation';
import { rowCompactStatusText, rowStatusText } from './row-model';
import { type ExecutionRowController, useExecutionRow } from './useExecutionRow';

function Avatars({ controller }: { controller: ExecutionRowController }) {
  const { model, executions } = controller;
  if (model.single)
    return (
      <span data-testid="execution-row-avatars" className="flex-none">
        <CatAvatar catId={model.single.catId} size={20} />
      </span>
    );
  const shown = executions.slice(0, 3);
  if (shown.length === 0) return null;
  return (
    <span data-testid="execution-row-avatars" className="flex items-center">
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

function Body({
  controller,
  open,
  tone,
  words,
}: {
  controller: ExecutionRowController;
  open: boolean;
  tone: ExecutionRowTone;
  words: ExecutionRowWords;
}) {
  const { model, resolveCatName } = controller;

  const fullStatus = rowStatusText(model, resolveCatName, words);
  return (
    <>
      <Avatars controller={controller} />
      <span
        data-testid="execution-row-dot"
        aria-hidden="true"
        className="h-2 w-2 flex-none rounded-full"
        style={{ backgroundColor: executionRowToneColor(tone) }}
      />
      <span
        data-testid="execution-row-text"
        className={`${styles.fullStatus} min-w-0 truncate font-medium text-cafe-secondary`}
      >
        {fullStatus}
      </span>
      <output
        data-testid="execution-row-text-compact"
        aria-label={fullStatus}
        className={`${styles.compactStatus} min-w-0 flex-1 items-center gap-1 font-medium text-cafe-secondary`}
      >
        {model.single ? <span className="min-w-0 truncate">{resolveCatName(model.single.catId)}</span> : null}
        <span className="flex-none whitespace-nowrap">{rowCompactStatusText(model, words)}</span>
      </output>
      {model.staleNote ? (
        <span
          data-testid="execution-row-stale"
          className="flex-none text-micro text-conn-amber-text"
          title={words.staleDetail}
        >
          {words.stale}
        </span>
      ) : null}
      {model.panelToggle && !model.single ? <Chevron open={open} /> : null}
    </>
  );
}

export function ExecutionRow({ threadId }: { threadId: string }) {
  const words = useShellCopy(executionRowCopy);
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
  const tone = executionRowTone(model.status);

  return (
    <div
      ref={rootRef}
      data-testid="execution-row"
      data-execution-thread-id={threadId}
      data-execution-keys={JSON.stringify(controller.executions.map(activeExecutionKey))}
      tabIndex={-1}
      data-status={model.status}
      data-tone={tone}
      className={`${styles.container} relative mb-2 px-4`}
    >
      <div
        data-testid="execution-row-surface"
        className="flex h-9 items-center gap-2 rounded-xl border px-3 text-xs"
        style={{ background: executionRowToneSurface(tone), borderColor: executionRowToneColor(tone) }}
      >
        {model.single ? (
          <button
            type="button"
            data-testid="execution-row-locate"
            aria-label={words.actions.locate}
            title={rowStatusText(model, controller.resolveCatName, words)}
            onClick={() => model.single && controller.locate(model.single)}
            className="shell-focusable flex min-w-0 flex-1 items-center gap-2 text-left"
          >
            <Body controller={controller} open={false} tone={tone} words={words} />
          </button>
        ) : model.panelToggle ? (
          <button
            type="button"
            data-testid="execution-row-toggle"
            aria-expanded={panelOpen}
            onClick={() => setOpen(!panelOpen)}
            className="flex min-w-0 flex-1 items-center gap-2 text-left"
          >
            <Body controller={controller} open={panelOpen} tone={tone} words={words} />
          </button>
        ) : (
          <div className="flex min-w-0 flex-1 items-center gap-2">
            <Body controller={controller} open={false} tone={tone} words={words} />
          </div>
        )}
        {model.single && model.panelToggle ? (
          <button
            type="button"
            data-testid="execution-row-toggle"
            aria-expanded={panelOpen}
            aria-label={words.panel.queue(model.visibleQueueCount)}
            onClick={() => setOpen(!panelOpen)}
            className="shell-focusable flex-none"
          >
            <Chevron open={panelOpen} />
          </button>
        ) : null}
        <ExecutionRowActions controller={controller} words={words} />
      </div>
      {panelOpen ? <ExecutionRowPanel controller={controller} /> : null}
      {steerEntry && steerEntry.status === 'queued' ? (
        <QueueSteerDialog
          key={`${threadId}:${steerEntry.id}`}
          threadId={threadId}
          entry={steerEntry}
          queue={controller.view.queue}
          onCancel={convergence.handleSteerCancel}
          onConfirm={convergence.handleSteerConfirm}
        />
      ) : null}
      <ForceResetDialog {...forceReset.dialog} />
    </div>
  );
}
