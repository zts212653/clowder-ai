'use client';

import type { RichCardBlock } from '@/stores/chat-types';
import { MarkdownContent } from '../MarkdownContent';

export interface PersonMemoryProposalCardViewProps {
  title: string;
  bodyMarkdown?: string;
  fields?: RichCardBlock['fields'];
  hydrated: boolean;
  hydrationError: string | null;
  statusLabel: string | null;
  receiptSummary: string | null;
  canNavigate: boolean;
  navigateLabel: string;
  onNavigate: () => void;
  canUndo: boolean;
  undoing: boolean;
  onUndo: () => void;
}

export function PersonMemoryProposalCardView(props: PersonMemoryProposalCardViewProps) {
  return (
    <div className="rounded-xl border border-conn-blue-ring bg-[var(--cafe-surface-elevated)]/80 p-4 shadow-[var(--console-shadow-soft)] backdrop-blur-md">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="text-sm font-semibold leading-snug text-[var(--cafe-text)]">{props.title}</div>
          {props.bodyMarkdown && (
            <div className="mt-1 text-xs leading-relaxed text-cafe-secondary [&_p]:mb-1 [&_p:last-child]:mb-0">
              <MarkdownContent content={props.bodyMarkdown} className="!text-xs" disableCommandPrefix />
            </div>
          )}
        </div>
        <span className="shrink-0 rounded-full border border-conn-blue-ring bg-conn-blue-bg px-2 py-0.5 text-xs font-medium text-conn-blue-text">
          私人记忆
        </span>
      </div>

      {(props.fields?.length ?? 0) > 0 && (
        <div className="mt-3 grid grid-cols-1 gap-2 sm:grid-cols-2">
          {props.fields?.map((field) => (
            <div
              key={field.label}
              className="rounded-lg border border-[var(--console-border-soft)] bg-cafe-surface px-3 py-2 text-xs"
            >
              <div className="font-semibold text-cafe-muted">{field.label}</div>
              <div className="mt-0.5 text-cafe-secondary">{field.value}</div>
            </div>
          ))}
        </div>
      )}

      {!props.hydrated ? (
        <div className="mt-4 border-t border-[var(--console-border-soft)] pt-3 text-xs text-cafe-muted">
          正在核验审批状态…
        </div>
      ) : props.hydrationError ? (
        <div className="mt-4 border-t border-[var(--console-border-soft)] pt-3 text-xs text-conn-red-text">
          {props.hydrationError}
        </div>
      ) : (
        <div className="mt-4 flex flex-wrap items-center gap-2.5 border-t border-[var(--console-border-soft)] pt-3">
          {props.statusLabel && (
            <span className="rounded-full border border-conn-blue-ring bg-conn-blue-bg px-2.5 py-1 text-xs text-conn-blue-text">
              {props.statusLabel}
            </span>
          )}
          {props.receiptSummary && (
            <span className="text-xs text-cafe-secondary" data-testid="person-memory-receipt">
              回执：{props.receiptSummary}
            </span>
          )}
          {props.canNavigate && (
            <button
              type="button"
              onClick={props.onNavigate}
              className="rounded-lg bg-[var(--semantic-info)] px-4 py-1.5 text-xs font-semibold text-[var(--cafe-surface)] shadow-[var(--console-shadow-soft)] transition-opacity hover:opacity-90"
              data-testid="person-memory-open-approval-hub"
            >
              {props.navigateLabel}
            </button>
          )}
          {props.canUndo && (
            <button
              type="button"
              onClick={props.onUndo}
              disabled={props.undoing}
              className="rounded-lg border border-[var(--cafe-border)] px-3 py-1.5 text-xs font-medium text-cafe-secondary transition-opacity hover:opacity-80 disabled:opacity-50"
              data-testid="person-memory-undo"
            >
              {props.undoing ? '撤销中…' : '撤销本次写入'}
            </button>
          )}
        </div>
      )}
    </div>
  );
}
