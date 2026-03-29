'use client';

import { useEffect, useState } from 'react';
import type { GitCommit } from '../../hooks/useGitPanel';
import { useGitPanel } from '../../hooks/useGitPanel';
import { HealthDashboard } from './HealthDashboard';

function StatusBadge({ status, variant }: { status: string; variant: 'staged' | 'unstaged' | 'untracked' }) {
  const colors = {
    staged: 'bg-green-100 text-green-700',
    unstaged: 'bg-amber-100 text-amber-700',
    untracked: 'bg-cafe-surface-elevated text-cafe-secondary',
  };
  return (
    <span className={`inline-block px-1 py-0.5 rounded text-[9px] font-mono font-bold ${colors[variant]}`}>
      {status}
    </span>
  );
}

function StatusSection({
  title,
  items,
  variant,
}: {
  title: string;
  items: Array<{ status: string; path: string }>;
  variant: 'staged' | 'unstaged' | 'untracked';
}) {
  if (items.length === 0) return null;
  return (
    <div className="mb-2">
      <div className="text-[10px] font-semibold text-cocreator-dark/50 uppercase tracking-wider mb-1">
        {title} ({items.length})
      </div>
      <div className="space-y-0.5">
        {items.map((item) => (
          <div
            key={item.path}
            className="flex items-center gap-1.5 text-xs font-mono text-cafe-black/80 py-0.5 px-1 rounded hover:bg-cocreator-light/30"
          >
            <StatusBadge status={item.status} variant={variant} />
            <span className="truncate">{item.path}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

function CommitRow({ commit, isExpanded, onToggle }: { commit: GitCommit; isExpanded: boolean; onToggle: () => void }) {
  const relDate = formatRelativeDate(commit.date);
  return (
    <button
      type="button"
      onClick={onToggle}
      className={`w-full text-left px-2 py-1.5 text-xs hover:bg-cocreator-light/30 transition-colors border-b border-cocreator-light/20 ${isExpanded ? 'bg-cocreator-light/20' : ''}`}
    >
      <div className="flex items-center gap-2">
        <span className="font-mono text-cocreator-primary/70 text-[10px] shrink-0">{commit.short}</span>
        <span className="truncate text-cafe-black/80 flex-1">{commit.subject}</span>
        <span className="text-[10px] text-cocreator-dark/40 shrink-0">{relDate}</span>
      </div>
      <div className="text-[10px] text-cocreator-dark/40 mt-0.5">{commit.author}</div>
    </button>
  );
}

function formatRelativeDate(isoDate: string): string {
  const diff = Date.now() - new Date(isoDate).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d`;
  return new Date(isoDate).toLocaleDateString();
}

export function GitPanel() {
  const { commits, status, commitDetail, loading, error, fetchCommitDetail, refresh } = useGitPanel();
  const [expandedHash, setExpandedHash] = useState<string | null>(null);
  const [statusCollapsed, setStatusCollapsed] = useState(false);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const handleToggleCommit = (hash: string) => {
    if (expandedHash === hash) {
      setExpandedHash(null);
    } else {
      setExpandedHash(hash);
      fetchCommitDetail(hash);
    }
  };

  const totalChanges = status ? status.staged.length + status.unstaged.length + status.untracked.length : 0;

  return (
    <div className="flex flex-col h-full overflow-hidden">
      {/* Refresh button */}
      <div className="flex items-center justify-between px-3 py-1.5 border-b border-cocreator-light/40">
        <span className="text-[10px] font-semibold text-cocreator-dark/50 uppercase tracking-wider">
          {status?.branch ? `Branch: ${status.branch}` : 'Git'}
        </span>
        <button
          type="button"
          onClick={refresh}
          disabled={loading}
          className="text-[10px] text-cocreator-primary hover:text-cocreator-primary/80 disabled:opacity-50"
        >
          {loading ? '...' : 'Refresh'}
        </button>
      </div>

      {error && <div className="px-3 py-2 text-xs text-red-600 bg-red-50/80 border-b border-red-100">{error}</div>}

      <div className="flex-1 overflow-y-auto">
        {/* Git Status Section */}
        {status && totalChanges > 0 && (
          <div className="border-b border-cocreator-light/40">
            <button
              type="button"
              onClick={() => setStatusCollapsed(!statusCollapsed)}
              className="w-full flex items-center justify-between px-3 py-1.5 hover:bg-cocreator-light/20"
            >
              <span className="text-[10px] font-semibold text-cocreator-dark/60 uppercase tracking-wider">
                Status ({totalChanges} changes)
              </span>
              <span className="text-[10px] text-cocreator-dark/40">{statusCollapsed ? '▸' : '▾'}</span>
            </button>
            {!statusCollapsed && (
              <div className="px-3 pb-2">
                <StatusSection title="Staged" items={status.staged} variant="staged" />
                <StatusSection title="Modified" items={status.unstaged} variant="unstaged" />
                <StatusSection title="Untracked" items={status.untracked} variant="untracked" />
              </div>
            )}
          </div>
        )}

        {status && totalChanges === 0 && (
          <div className="px-3 py-2 text-xs text-green-600 border-b border-cocreator-light/40">Working tree clean</div>
        )}

        {/* Health Dashboard (Phase 2) */}
        <HealthDashboard />

        {/* Git Log Section */}
        <div>
          <div className="px-3 py-1.5 text-[10px] font-semibold text-cocreator-dark/50 uppercase tracking-wider sticky top-0 bg-cafe-white/95 backdrop-blur-sm border-b border-cocreator-light/20">
            Commits ({commits.length})
          </div>
          {commits.map((commit) => (
            <div key={commit.hash}>
              <CommitRow
                commit={commit}
                isExpanded={expandedHash === commit.hash}
                onToggle={() => handleToggleCommit(commit.hash)}
              />
              {expandedHash === commit.hash && commitDetail && commitDetail.hash === commit.hash && (
                <div className="bg-cocreator-light/10 px-3 py-2 border-b border-cocreator-light/30">
                  {commitDetail.files.length === 0 ? (
                    <div className="text-[10px] text-cocreator-dark/40">No file changes</div>
                  ) : (
                    <div className="space-y-0.5">
                      {commitDetail.files.map((f) => (
                        <div key={f.path} className="flex items-center justify-between text-[10px] font-mono">
                          <span className="text-cafe-black/70 truncate">{f.path}</span>
                          <span className="text-cocreator-dark/40 shrink-0 ml-2">{f.summary}</span>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              )}
            </div>
          ))}
          {commits.length === 0 && !loading && (
            <div className="px-3 py-4 text-xs text-cocreator-dark/40 text-center">No commits found</div>
          )}
        </div>
      </div>
    </div>
  );
}
