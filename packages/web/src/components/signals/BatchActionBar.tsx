import type { SignalArticleStatus } from '@cat-cafe/shared';
import { useCallback, useState } from 'react';
import { batchSignalArticles } from '@/utils/signals-api';

interface BatchActionBarProps {
  readonly selectedIds: ReadonlySet<string>;
  readonly onClear: () => void;
  readonly onComplete: () => void;
}

export function BatchActionBar({ selectedIds, onClear, onComplete }: BatchActionBarProps) {
  const [busy, setBusy] = useState(false);
  const [tagInput, setTagInput] = useState('');
  const [showTagInput, setShowTagInput] = useState(false);
  const count = selectedIds.size;

  const doBatch = useCallback(
    async (action: 'update' | 'delete', fields?: { status?: SignalArticleStatus; tags?: string[] }) => {
      if (count === 0) return;
      setBusy(true);
      try {
        const ids = Array.from(selectedIds);
        await batchSignalArticles(ids, action, fields);
        onClear();
        onComplete();
        setShowTagInput(false);
        setTagInput('');
      } finally {
        setBusy(false);
      }
    },
    [count, selectedIds, onClear, onComplete],
  );

  const handleAddTag = useCallback(() => {
    const tag = tagInput.trim();
    if (!tag) return;
    void doBatch('update', { tags: [tag] });
  }, [tagInput, doBatch]);

  if (count === 0) return null;

  return (
    <div className="flex flex-wrap items-center gap-2 rounded-lg border border-opus-light bg-opus-bg px-3 py-2 text-xs">
      <span className="font-medium text-opus-dark">已选 {count} 篇</span>
      <button
        type="button"
        disabled={busy}
        onClick={() => void doBatch('update', { status: 'read' })}
        className="rounded border border-[var(--console-border-soft)] px-2 py-1 hover:bg-cafe-surface-elevated disabled:opacity-50"
      >
        标记已读
      </button>
      <button
        type="button"
        disabled={busy}
        onClick={() => void doBatch('update', { status: 'archived' })}
        className="rounded border border-[var(--console-border-soft)] px-2 py-1 hover:bg-cafe-surface-elevated disabled:opacity-50"
      >
        归档
      </button>
      <button
        type="button"
        disabled={busy}
        onClick={() => setShowTagInput((v) => !v)}
        className="rounded border border-[var(--console-border-soft)] px-2 py-1 hover:bg-cafe-surface-elevated disabled:opacity-50"
      >
        加标签
      </button>
      <button
        type="button"
        disabled={busy}
        onClick={() => void doBatch('delete')}
        className="rounded border border-conn-red-ring px-2 py-1 text-conn-red-text hover:bg-conn-red-bg disabled:opacity-50"
      >
        删除
      </button>
      {showTagInput && (
        <div className="flex gap-1">
          <input
            value={tagInput}
            onChange={(e) => setTagInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                handleAddTag();
              }
            }}
            placeholder="标签名..."
            className="rounded border border-[var(--console-border-soft)] px-2 py-1 text-xs"
          />
          <button
            type="button"
            disabled={busy || !tagInput.trim()}
            onClick={handleAddTag}
            className="rounded border border-opus-light px-2 py-1 text-opus-dark hover:bg-opus-bg disabled:opacity-50"
          >
            确定
          </button>
        </div>
      )}
      <button type="button" onClick={onClear} className="ml-auto text-cafe-secondary hover:text-cafe-secondary">
        取消选择
      </button>
    </div>
  );
}
