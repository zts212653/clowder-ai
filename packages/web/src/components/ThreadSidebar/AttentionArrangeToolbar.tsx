'use client';

import { AppTooltip } from '../AppTooltip';
import { useShellCopy } from '../shell/shell-copy';
import { threadSignalsCopy } from './thread-signals.shell-copy';

interface AttentionArrangeToolbarProps {
  compact?: boolean;
  hint?: { text: string; summary: string } | null;
  draggedThreadId: string | null;
  canRemoveDragged: boolean;
  onRemoveDragged: (threadId: string) => void;
  onDone: () => void;
}

export function AttentionArrangeToolbar({
  compact = false,
  hint,
  draggedThreadId,
  canRemoveDragged,
  onRemoveDragged,
  onDone,
}: AttentionArrangeToolbarProps) {
  const copy = useShellCopy(threadSignalsCopy);
  return (
    <div
      role="toolbar"
      aria-label={compact ? copy.arrangeTitle : '整理对话'}
      data-testid="attention-arrange-toolbar"
      className={
        compact
          ? 'sticky top-0 z-10 flex h-10 items-center gap-2 bg-cafe-surface-elevated px-3 text-micro text-cafe-secondary'
          : 'mx-2 mb-1 flex items-center gap-2 rounded-xl border border-cafe-subtle bg-cafe-surface-elevated px-3 py-2 text-micro text-cafe-secondary shadow-[var(--console-shadow-soft)]'
      }
      data-scroll-occluder={compact || undefined}
    >
      {compact && (
        <span className="sr-only" role="status">
          {copy.arrangeEntered}
        </span>
      )}
      {(!compact || !draggedThreadId || !canRemoveDragged) &&
        (hint && compact ? (
          <AppTooltip label={hint.text} intent="content" side="top" multiline>
            <span data-arrange-sort-hint className="min-w-0 flex-1 text-xs leading-tight line-clamp-2">
              {hint.summary}
            </span>
          </AppTooltip>
        ) : (
          <span className="min-w-0 flex-1 truncate">
            {compact ? copy.arrangeInstruction : '拖到另一条对话上建 Group'}
          </span>
        ))}
      {draggedThreadId && canRemoveDragged && (
        <button
          type="button"
          data-attention-remove-drop="true"
          onDragOver={(event) => {
            event.preventDefault();
            if (event.dataTransfer) event.dataTransfer.dropEffect = 'move';
          }}
          onDrop={(event) => {
            event.preventDefault();
            const sourceThreadId = draggedThreadId || event.dataTransfer?.getData('text/plain') || null;
            if (sourceThreadId) onRemoveDragged(sourceThreadId);
          }}
          className={`${compact ? 'min-w-0 flex-1 text-left' : 'shrink-0'} rounded-md px-2 py-1 text-conn-red-text hover:bg-conn-red-bg`}
        >
          {compact ? copy.arrangeRemove : '移出 Group'}
        </button>
      )}
      <button
        type="button"
        onClick={onDone}
        className="shrink-0 rounded-md bg-cafe-accent px-2 py-1 font-medium text-[var(--cafe-surface)]"
      >
        {compact ? copy.arrangeDone : '完成'}
      </button>
    </div>
  );
}
