'use client';

interface AttentionArrangeToolbarProps {
  draggedThreadId: string | null;
  canRemoveDragged: boolean;
  onRemoveDragged: (threadId: string) => void;
  onDone: () => void;
}

export function AttentionArrangeToolbar({
  draggedThreadId,
  canRemoveDragged,
  onRemoveDragged,
  onDone,
}: AttentionArrangeToolbarProps) {
  return (
    <div
      role="status"
      data-testid="attention-arrange-toolbar"
      className="mx-2 mb-1 flex items-center gap-2 rounded-xl border border-cafe-subtle bg-cafe-surface-elevated px-3 py-2 text-micro text-cafe-secondary shadow-[var(--console-shadow-soft)]"
    >
      <span className="min-w-0 flex-1">拖到另一条对话上建 Group</span>
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
          className="shrink-0 rounded-md px-2 py-1 text-conn-red-text hover:bg-conn-red-bg"
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
