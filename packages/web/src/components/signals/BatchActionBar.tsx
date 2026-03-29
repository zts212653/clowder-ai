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
  const count = selectedIds.size;

  const doBatch = useCallback(
    async (action: 'update' | 'delete', status?: SignalArticleStatus) => {
      if (count === 0) return;
      setBusy(true);
      try {
        const ids = Array.from(selectedIds);
        await batchSignalArticles(ids, action, status ? { status } : undefined);
        onClear();
        onComplete();
      } finally {
        setBusy(false);
      }
    },
    [count, selectedIds, onClear, onComplete],
  );

  if (count === 0) return null;

  return (
    <div className="flex items-center gap-2 rounded-lg border border-opus-light bg-opus-bg px-3 py-2 text-xs">
      <span className="font-medium text-opus-dark">已选 {count} 篇</span>
      <button
        type="button"
        disabled={busy}
        onClick={() => void doBatch('update', 'read')}
        className="rounded border border-cafe px-2 py-1 hover:bg-cafe-surface-elevated disabled:opacity-50"
      >
        标记已读
      </button>
      <button
        type="button"
        disabled={busy}
        onClick={() => void doBatch('update', 'archived')}
        className="rounded border border-cafe px-2 py-1 hover:bg-cafe-surface-elevated disabled:opacity-50"
      >
        归档
      </button>
      <button
        type="button"
        disabled={busy}
        onClick={() => void doBatch('delete')}
        className="rounded border border-red-200 px-2 py-1 text-red-600 hover:bg-red-50 disabled:opacity-50"
      >
        删除
      </button>
      <button type="button" onClick={onClear} className="ml-auto text-cafe-secondary hover:text-cafe-secondary">
        取消选择
      </button>
    </div>
  );
}
