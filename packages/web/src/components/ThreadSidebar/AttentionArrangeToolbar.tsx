'use client';

interface AttentionArrangeToolbarProps {
  compact?: boolean;
  draggedThreadId: string | null;
  canRemoveDragged: boolean;
  onRemoveDragged: (threadId: string) => void;
  onDone: () => void;
}

export function AttentionArrangeToolbar({
  compact = false,
  draggedThreadId,
  canRemoveDragged,
  onRemoveDragged,
  onDone,
}: AttentionArrangeToolbarProps) {
  return (
    <div
      role="toolbar"
      aria-label="整理对话"
      data-testid="attention-arrange-toolbar"
      className={
        compact
          ? 'sticky top-0 z-10 flex h-10 items-center gap-2 bg-cafe-surface-elevated px-3 text-micro text-cafe-secondary'
          : 'mx-2 mb-1 flex items-center gap-2 rounded-xl border border-cafe-subtle bg-cafe-surface-elevated px-3 py-2 text-micro text-cafe-secondary shadow-[var(--console-shadow-soft)]'
      }
      data-scroll-occluder={compact || undefined}
    >
      {(!compact || !draggedThreadId || !canRemoveDragged) && (
        <span className="min-w-0 flex-1 truncate">拖到另一条对话上建 Group</span>
      )}
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
          移出 Group
        </button>
      )}
      <button
        type="button"
        onClick={onDone}
        className="shrink-0 rounded-md bg-cafe-accent px-2 py-1 font-medium text-[var(--cafe-surface)]"
      >
        完成
      </button>
    </div>
  );
}
