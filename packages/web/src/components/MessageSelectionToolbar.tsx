'use client';

import { type ReactNode, useCallback, useState } from 'react';
import { apiFetch } from '@/utils/api-client';

type SelectionExportFormat = 'md' | 'txt' | 'png';

export interface MessageSelectionToolbarProps {
  threadId: string;
  selectedMessageIds: readonly string[];
  onCancel: () => void;
  onExportSuccess: () => void;
  /** Blocks only the network-forward action until this browser document is admitted. */
  forwardingDisabled: boolean;
  onForward?: () => void;
}

function selectionItems(selectedMessageIds: readonly string[]) {
  return selectedMessageIds.map((messageId) => ({ kind: 'message' as const, messageId }));
}

async function responseError(response: Response): Promise<Error> {
  const body = (await response.json().catch(() => ({}))) as { error?: string; message?: string };
  return new Error(body.message || body.error || `导出失败 (${response.status})`);
}

function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  URL.revokeObjectURL(url);
}

interface SelectionActionProps {
  label: string;
  busyLabel?: string;
  busy?: boolean;
  disabled?: boolean;
  title?: string;
  onClick: () => void;
  icon: ReactNode;
}

function SelectionAction({ label, busyLabel, busy, disabled, title, onClick, icon }: SelectionActionProps) {
  return (
    <button
      type="button"
      aria-label={label}
      aria-busy={busy}
      className="group flex w-11 shrink-0 flex-col items-center gap-1 rounded-xl px-0.5 py-1 text-xs font-medium text-cafe-secondary transition-colors hover:bg-cafe-surface-elevated hover:text-cafe-primary disabled:cursor-not-allowed disabled:opacity-40 sm:w-14"
      disabled={disabled}
      title={title}
      onClick={onClick}
    >
      <span className="grid h-9 w-9 place-items-center rounded-full border border-cafe bg-cafe-surface-elevated text-cafe-secondary transition-[background-color,border-color,transform] group-hover:border-cafe-accent group-hover:text-cafe-primary group-active:scale-95 sm:h-10 sm:w-10">
        {icon}
      </span>
      <span className="max-w-full truncate">{busy ? busyLabel : label}</span>
    </button>
  );
}

const iconClass = 'h-5 w-5';

export function MessageSelectionToolbar({
  threadId,
  selectedMessageIds,
  onCancel,
  onExportSuccess,
  forwardingDisabled,
  onForward,
}: MessageSelectionToolbarProps) {
  const [pendingFormat, setPendingFormat] = useState<SelectionExportFormat | null>(null);
  const [error, setError] = useState<string | null>(null);
  const hasSelection = selectedMessageIds.length > 0;

  const exportSelection = useCallback(
    async (format: SelectionExportFormat) => {
      if (!hasSelection || pendingFormat) return;
      setPendingFormat(format);
      setError(null);
      try {
        const items = selectionItems(selectedMessageIds);
        const response =
          format === 'png'
            ? await apiFetch(`/api/threads/${threadId}/export-selection-image`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ items }),
              })
            : await apiFetch(`/api/export/thread/${threadId}/selection`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ format, items }),
              });
        if (!response.ok) throw await responseError(response);

        const blob = await response.blob();
        const suffix = format === 'png' ? 'png' : format;
        downloadBlob(blob, `selection-${threadId}-${Date.now()}.${suffix}`);
        onExportSuccess();
      } catch (reason) {
        setError(reason instanceof Error ? reason.message : '导出失败，请重试');
      } finally {
        setPendingFormat(null);
      }
    },
    [hasSelection, onExportSuccess, pendingFormat, selectedMessageIds, threadId],
  );

  return (
    <section
      aria-label="消息多选操作"
      className="border-t border-cafe bg-cafe-surface px-3 pt-2 pb-[max(0.75rem,env(safe-area-inset-bottom))] shadow-[0_-8px_24px_var(--console-shadow-soft)]"
      data-selection-layout="action-dock"
      data-testid="message-selection-toolbar"
    >
      <div className="mx-auto max-w-3xl">
        {error && (
          <p className="mb-1 text-xs text-conn-red-text" role="alert">
            {error}
          </p>
        )}
        <div className="flex items-center gap-1">
          <p className="mr-auto w-12 shrink-0 pl-1 text-sm font-semibold tabular-nums text-cafe-primary sm:w-auto sm:min-w-16">
            <span className="sm:hidden">已选 {selectedMessageIds.length}</span>
            <span className="hidden sm:inline">已选 {selectedMessageIds.length} 条</span>
          </p>

          <div className="ml-auto flex items-start gap-0.5 sm:gap-2" data-testid="message-selection-actions">
            <SelectionAction
              label="文档"
              busyLabel="导出中"
              busy={pendingFormat === 'md'}
              icon={
                <svg aria-hidden="true" className={iconClass} fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.8} d="M7 3.75h7l3 3V20.25H7z" />
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth={1.8}
                    d="M14 3.75v3h3M9.5 11h5M9.5 14h5M9.5 17h3"
                  />
                </svg>
              }
              onClick={() => exportSelection('md')}
              disabled={!hasSelection || !!pendingFormat}
              title="导出 Markdown"
            />
            <SelectionAction
              label="文本"
              busyLabel="导出中"
              busy={pendingFormat === 'txt'}
              icon={
                <svg aria-hidden="true" className={iconClass} fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.8} d="M5 5h14M9 5v14M6.5 19h5" />
                </svg>
              }
              onClick={() => exportSelection('txt')}
              disabled={!hasSelection || !!pendingFormat}
              title="导出 TXT"
            />
            <SelectionAction
              label="长图"
              busyLabel="导出中"
              busy={pendingFormat === 'png'}
              icon={
                <svg aria-hidden="true" className={iconClass} fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <rect width="15" height="18" x="4.5" y="3" rx="2" strokeWidth={1.8} />
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth={1.8}
                    d="m7.5 16 3.25-3.25 2.5 2.5 1.75-1.75 1.5 1.5M8.5 8.5h.01"
                  />
                </svg>
              }
              onClick={() => exportSelection('png')}
              disabled={!hasSelection || !!pendingFormat}
            />
            <SelectionAction
              label="转发"
              icon={
                <svg aria-hidden="true" className={iconClass} fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth={1.8}
                    d="m14 5 5 5-5 5M19 10H9a4 4 0 0 0-4 4v5"
                  />
                </svg>
              }
              onClick={() => onForward?.()}
              disabled={!hasSelection || !!pendingFormat || forwardingDisabled || !onForward}
              title={
                forwardingDisabled
                  ? '正在验证页面版本，暂不可转发'
                  : onForward
                    ? '转发所选消息'
                    : '转发将在 Phase B 开放'
              }
            />
            <SelectionAction
              label="取消"
              icon={
                <svg aria-hidden="true" className={iconClass} fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeWidth={1.8} d="m7 7 10 10M17 7 7 17" />
                </svg>
              }
              onClick={onCancel}
            />
          </div>
        </div>
      </div>
    </section>
  );
}
