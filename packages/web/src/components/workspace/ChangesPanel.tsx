'use client';

import { useCallback, useEffect, useState } from 'react';
import { apiFetch } from '@/utils/api-client';
import { DiffViewer } from './DiffViewer';
import { FileIcon } from './FileIcons';

interface ChangedFile {
  status: string;
  path: string;
}

interface DiffData {
  changedFiles: ChangedFile[];
  diff: string;
}

const statusLabels: Record<string, { label: string; color: string }> = {
  M: { label: 'M', color: 'text-conn-amber-text' },
  A: { label: 'A', color: 'text-conn-emerald-text' },
  D: { label: 'D', color: 'text-conn-red-text' },
  R: { label: 'R', color: 'text-[var(--color-cafe-accent)]' },
  '?': { label: 'U', color: 'text-cafe-muted' },
  '??': { label: 'U', color: 'text-cafe-muted' },
};

function getStatusInfo(status: string) {
  return statusLabels[status] ?? { label: status, color: 'text-cafe-muted' };
}

interface ChangesPanelProps {
  worktreeId: string | null;
  basisPct: number;
}

export function ChangesPanel({ worktreeId, basisPct }: ChangesPanelProps) {
  const [data, setData] = useState<DiffData | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selectedFile, setSelectedFile] = useState<string | null>(null);

  const fetchDiff = useCallback(async () => {
    if (!worktreeId) return;
    setLoading(true);
    setError(null);
    try {
      const res = await apiFetch(`/api/workspace/diff?worktreeId=${encodeURIComponent(worktreeId)}`);
      if (!res.ok) {
        setError('Failed to fetch changes');
        return;
      }
      const json = await res.json();
      setData(json);
    } catch {
      setError('Network error');
    } finally {
      setLoading(false);
    }
  }, [worktreeId]);

  useEffect(() => {
    fetchDiff();
  }, [fetchDiff]);

  if (!worktreeId) {
    return <div className="p-4 text-center text-cafe-secondary text-xs">No worktree selected</div>;
  }

  return (
    <div className="flex flex-col min-h-0 flex-1">
      {/* Changed files list */}
      <div
        className="flex-shrink-0 overflow-y-auto border-b border-[var(--console-border-soft)]"
        style={{ maxHeight: `${basisPct}%` }}
      >
        <div className="sticky top-0 flex items-center justify-between bg-cafe-white/95 px-3 py-1.5 backdrop-blur-sm">
          <span className="text-[10px] font-semibold uppercase tracking-wider text-cafe-muted">
            {data ? `${data.changedFiles.length} changed` : 'Changes'}
          </span>
          <button
            type="button"
            onClick={fetchDiff}
            disabled={loading}
            className="rounded-md px-2 py-1 text-[10px] text-cafe-muted transition-colors hover:bg-[var(--console-hover-bg)] hover:text-cafe-secondary disabled:opacity-50"
            title="Refresh"
          >
            {loading ? '...' : '↻'}
          </button>
        </div>
        {error && <div className="px-3 py-1.5 text-[10px] text-conn-red-text">{error}</div>}
        {data?.changedFiles.map((f) => {
          const info = getStatusInfo(f.status);
          return (
            <button
              key={f.path}
              type="button"
              onClick={() => setSelectedFile(selectedFile === f.path ? null : f.path)}
              className={`flex w-full items-center gap-1.5 px-3 py-1 text-left transition-colors hover:bg-[var(--console-hover-bg)] ${
                selectedFile === f.path ? 'bg-[var(--console-active-bg)]' : ''
              }`}
            >
              <span className={`text-[10px] font-mono font-bold w-3 ${info.color}`}>{info.label}</span>
              <FileIcon name={f.path} />
              <span className="text-[11px] text-cafe-black truncate">{f.path.split('/').pop()}</span>
              <span className="text-[9px] text-cafe-muted truncate ml-auto">
                {f.path.includes('/') ? f.path.slice(0, f.path.lastIndexOf('/')) : ''}
              </span>
            </button>
          );
        })}
        {data && data.changedFiles.length === 0 && (
          <div className="px-3 py-4 text-center text-cafe-muted text-xs">No uncommitted changes</div>
        )}
      </div>

      {/* Diff viewer */}
      <div className="flex-1 min-h-0 overflow-auto bg-[var(--terminal-bg-deep)]">
        {data?.diff ? (
          <DiffViewer diff={data.diff} filePath={selectedFile ?? undefined} />
        ) : (
          <div className="p-4 text-center text-cafe-secondary text-xs">
            {loading ? 'Loading...' : 'Select a file to view diff'}
          </div>
        )}
      </div>
    </div>
  );
}
