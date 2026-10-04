'use client';

import { useCallback, useState } from 'react';
import { apiFetch } from '@/utils/api-client';

interface LinkedRootsManagerProps {
  onRootsChanged: () => void;
  compact?: boolean;
}

export function LinkedRootsManager({ onRootsChanged, compact = false }: LinkedRootsManagerProps) {
  const [adding, setAdding] = useState(false);
  const [name, setName] = useState('');
  const [path, setPath] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const handleAdd = useCallback(async () => {
    if (!name.trim() || !path.trim()) return;
    setSubmitting(true);
    setError(null);
    try {
      const res = await apiFetch('/api/workspace/linked-roots', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: name.trim(), path: path.trim() }),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error ?? 'Failed to add linked root');
        return;
      }
      setName('');
      setPath('');
      setAdding(false);
      onRootsChanged();
    } catch {
      setError('Network error');
    } finally {
      setSubmitting(false);
    }
  }, [name, path, onRootsChanged]);

  if (!adding) {
    return (
      <button
        type="button"
        onClick={() => setAdding(true)}
        className={
          compact
            ? 'inline-flex h-7 shrink-0 items-center rounded-lg px-2 text-micro font-semibold text-cafe-secondary transition-colors hover:bg-cafe-surface-sunken hover:text-cafe-accent'
            : 'w-full px-3 py-1.5 text-left text-micro text-cafe-interactive/60 transition-colors hover:bg-cafe-surface/50 hover:text-cafe-accent'
        }
      >
        {compact ? '添加外部文件夹' : '+ 连接外部文件夹…'}
      </button>
    );
  }

  return (
    <div
      className={
        compact
          ? 'basis-full space-y-1.5 border-t border-cafe-subtle/40 px-1 pt-2'
          : 'space-y-1.5 border-t border-cafe-subtle/40 px-3 py-2'
      }
    >
      <div className="text-micro font-medium text-cafe-black">连接外部文件夹</div>
      <input
        type="text"
        placeholder="名称（例如 studio-flow）"
        value={name}
        onChange={(e) => setName(e.target.value)}
        className="w-full text-micro border border-cafe-subtle rounded px-2 py-1 bg-cafe-surface/80 text-cafe-black focus:outline-none focus:border-cafe-accent"
      />
      <input
        type="text"
        placeholder="绝对路径（例如 /home/user/projects/studio-flow）"
        value={path}
        onChange={(e) => setPath(e.target.value)}
        className="w-full text-micro border border-cafe-subtle rounded px-2 py-1 bg-cafe-surface/80 text-cafe-black focus:outline-none focus:border-cafe-accent"
      />
      {error && <div className="text-micro text-conn-red-text">{error}</div>}
      <div className="flex gap-1.5">
        <button
          type="button"
          onClick={handleAdd}
          disabled={submitting || !name.trim() || !path.trim()}
          className="px-2 py-0.5 rounded text-micro font-medium bg-cafe-accent text-[var(--cafe-surface)] hover:bg-cafe-accent/80 disabled:opacity-50 transition-colors"
        >
          {submitting ? '连接中…' : '连接'}
        </button>
        <button
          type="button"
          onClick={() => {
            setAdding(false);
            setError(null);
          }}
          className="px-2 py-0.5 rounded text-micro font-medium text-cafe-interactive/60 hover:text-cafe-black transition-colors"
        >
          取消
        </button>
      </div>
    </div>
  );
}

export function LinkedRootRemoveButton({
  id,
  expectedEpoch,
  removable,
  onRemoved,
}: {
  id: string;
  expectedEpoch?: number;
  removable?: boolean;
  onRemoved: () => void;
}) {
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  if (!removable || expectedEpoch === undefined) return null;
  const handleRemove = async (e: React.MouseEvent) => {
    e.stopPropagation();
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const res = await apiFetch(
        `/api/workspace/linked-roots?${new URLSearchParams({ id, expectedEpoch: String(expectedEpoch) })}`,
        {
          method: 'DELETE',
        },
      );
      if (res.ok) onRemoved();
      else setError(res.status === 409 ? '连接已变化，请重新核对。' : '暂时无法核对移除结果，请重试。');
    } catch {
      setError('移除结果尚待核对，请重试；不会删除原文件。');
    } finally {
      setBusy(false);
    }
  };
  return (
    <span>
      <button
        type="button"
        onClick={handleRemove}
        disabled={busy}
        title="移除此共享连接，保留原文件和讨论"
        className="ml-1 text-xs text-conn-red-text/60 hover:text-conn-red-text transition-colors"
      >
        {busy ? '核对中…' : '移除共享连接'}
      </button>
      {error && (
        <span role="alert" className="block text-xs text-conn-red-text">
          {error}
        </span>
      )}
    </span>
  );
}
