'use client';
import type { ReactNode } from 'react';
import type { RichBlock } from '@/stores/chat-types';
import { richBlockSelectionLabel } from '../message-part-selection';
import { useRichBlockSelection } from '../message-part-selection-context';

/** Keep this wrapper mounted in both modes so selecting never resets an interactive card's local form. */
export function RichBlockSelectionFrame({
  block,
  index,
  messageId,
  readOnly,
  children,
}: {
  block: RichBlock;
  index: number;
  messageId?: string;
  readOnly?: boolean;
  children: ReactNode;
}) {
  const context = useRichBlockSelection();
  const selection = !readOnly && context?.messageId === messageId ? context : null;
  const checked = selection?.selection?.blockIds.has(block.id) ?? false;
  return (
    <div data-rich-block-id={block.id} className="group/rich-block relative">
      <div className={selection && !checked ? 'opacity-[.55]' : undefined}>{children}</div>
      {selection && (
        <button
          type="button"
          role="checkbox"
          data-quote-exclude
          aria-checked={checked}
          aria-label={`选择卡片：${richBlockSelectionLabel(block, index)}`}
          disabled={selection.disabled}
          onClick={() => selection.onToggle?.(selection.messageId, block.id)}
          className={`absolute -left-[9px] -top-[9px] z-20 grid h-[18px] w-[18px] place-items-center rounded-[5px] border-[1.5px] disabled:cursor-not-allowed ${
            checked
              ? 'border-[var(--semantic-success)] bg-[var(--semantic-success)] text-[var(--cafe-surface)]'
              : 'border-[var(--console-border-strong)] bg-cafe-surface text-cafe-muted'
          }`}
        >
          {checked && (
            <svg aria-hidden="true" className="h-3 w-3" viewBox="0 0 16 16" fill="none" stroke="currentColor">
              <path d="m3 8 3 3 7-7" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          )}
        </button>
      )}
    </div>
  );
}
