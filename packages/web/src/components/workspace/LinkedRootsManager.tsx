'use client';

import { useCallback, useState } from 'react';
import { apiFetch } from '@/utils/api-client';

interface LinkedRootsManagerProps {
  onRootsChanged: () => void;
}

export function LinkedRootsManager({ onRootsChanged }: LinkedRootsManagerProps) {
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
        className="w-full text-left px-3 py-1.5 text-[10px] text-cocreator-dark/60 hover:text-cocreator-primary hover:bg-cocreator-bg/50 transition-colors"
      >
        + Link external folder...
      </button>
    );
  }

  return (
    <div className="px-3 py-2 border-t border-cocreator-light/40 space-y-1.5">
      <div className="text-[10px] font-medium text-cafe-black">Link External Folder</div>
      <input
        type="text"
        placeholder="Name (e.g. studio-flow)"
        value={name}
        onChange={(e) => setName(e.target.value)}
        className="w-full text-[10px] border border-cocreator-light rounded px-2 py-1 bg-cafe-surface/80 text-cafe-black focus:outline-none focus:border-cocreator-primary"
      />
      <input
        type="text"
        placeholder="Absolute path (e.g. /home/user/projects/studio-flow)"
        value={path}
        onChange={(e) => setPath(e.target.value)}
        className="w-full text-[10px] border border-cocreator-light rounded px-2 py-1 bg-cafe-surface/80 text-cafe-black focus:outline-none focus:border-cocreator-primary"
      />
      {error && <div className="text-[10px] text-red-500">{error}</div>}
      <div className="flex gap-1.5">
        <button
          type="button"
          onClick={handleAdd}
          disabled={submitting || !name.trim() || !path.trim()}
          className="px-2 py-0.5 rounded text-[10px] font-medium bg-cocreator-primary text-white hover:bg-cocreator-primary/80 disabled:opacity-50 transition-colors"
        >
          {submitting ? 'Adding...' : 'Add'}
        </button>
        <button
          type="button"
          onClick={() => {
            setAdding(false);
            setError(null);
          }}
          className="px-2 py-0.5 rounded text-[10px] font-medium text-cocreator-dark/60 hover:text-cafe-black transition-colors"
        >
          Cancel
        </button>
      </div>
    </div>
  );
}

export function LinkedRootRemoveButton({ id, onRemoved }: { id: string; onRemoved: () => void }) {
  if (!id.startsWith('linked_')) return null;
  const handleRemove = async (e: React.MouseEvent) => {
    e.stopPropagation();
    try {
      const res = await apiFetch(`/api/workspace/linked-roots?id=${encodeURIComponent(id)}`, {
        method: 'DELETE',
      });
      if (res.ok) onRemoved();
    } catch {
      /* ignore */
    }
  };
  return (
    <button
      type="button"
      onClick={handleRemove}
      title="Unlink this folder"
      className="ml-1 text-[8px] text-red-400/60 hover:text-red-500 transition-colors"
    >
      x
    </button>
  );
}
