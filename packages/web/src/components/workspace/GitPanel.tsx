'use client';

import { useEffect, useState } from 'react';
import type { GitCommit } from '../../hooks/useGitPanel';
import { useGitPanel } from '../../hooks/useGitPanel';
import { HealthDashboard } from './HealthDashboard';

function StatusBadge({ status, variant }: { status: string; variant: 'staged' | 'unstaged' | 'untracked' }) {
  const colors = {
    staged: 'bg-conn-emerald-bg text-conn-emerald-text',
    unstaged: 'bg-conn-amber-bg text-conn-amber-text',
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
      <div className="mb-1 text-[10px] font-semibold uppercase tracking-wider text-cafe-muted">
        {title} ({items.length})
      </div>
      <div className="space-y-0.5">
        {items.map((item) => (
          <div
            key={item.path}
            className="flex items-center gap-1.5 rounded px-1 py-0.5 text-xs font-mono text-cafe-black/80 hover:bg-[var(--console-hover-bg)]"
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
      className={`w-full border-b border-[var(--console-border-soft)] px-2 py-1.5 text-left text-xs transition-colors hover:bg-[var(--console-hover-bg)] ${
        isExpanded ? 'bg-[var(--console-active-bg)]' : ''
      }`}
    >
      <div className="flex items-center gap-2">
        <span className="shrink-0 font-mono text-[10px] text-cafe-secondary">{commit.short}</span>
        <span className="truncate text-cafe-black/80 flex-1">{commit.subject}</span>
        <span className="shrink-0 text-[10px] text-cafe-muted">{relDate}</span>
      </div>
      <div className="mt-0.5 text-[10px] text-cafe-muted">{commit.author}</div>
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
      <div className="flex items-center justify-between border-b border-[var(--console-border-soft)] px-3 py-1.5">
        <span className="text-[10px] font-semibold uppercase tracking-wider text-cafe-muted">
          {status?.branch ? `Branch: ${status.branch}` : 'Git'}
        </span>
        <button
          type="button"
          onClick={refresh}
          disabled={loading}
          className="rounded-md px-2 py-1 text-[10px] text-cafe-secondary transition-colors hover:bg-[var(--console-hover-bg)] hover:text-cafe disabled:opacity-50"
        >
          {loading ? '...' : 'Refresh'}
        </button>
      </div>

      {error && (
        <div className="px-3 py-2 text-xs text-conn-red-text bg-conn-red-bg/80 border-b border-conn-red-ring">
          {error}
        </div>
      )}

      <div className="flex-1 overflow-y-auto">
        {/* Git Status Section */}
        {status && totalChanges > 0 && (
          <div className="border-b border-[var(--console-border-soft)]">
            <button
              type="button"
              onClick={() => setStatusCollapsed(!statusCollapsed)}
              className="flex w-full items-center justify-between px-3 py-1.5 hover:bg-[var(--console-hover-bg)]"
            >
              <span className="text-[10px] font-semibold uppercase tracking-wider text-cafe-muted">
                Status ({totalChanges} changes)
              </span>
              <span className="text-[10px] text-cafe-muted">{statusCollapsed ? '▸' : '▾'}</span>
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
          <div className="border-b border-[var(--console-border-soft)] px-3 py-2 text-xs text-conn-emerald-text">
            Working tree clean
          </div>
        )}

        {/* Health Dashboard (Phase 2) */}
        <HealthDashboard />

        {/* Git Log Section */}
        <div>
          <div className="sticky top-0 border-b border-[var(--console-border-soft)] bg-cafe-white/95 px-3 py-1.5 text-[10px] font-semibold uppercase tracking-wider text-cafe-muted backdrop-blur-sm">
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
                <div className="border-b border-[var(--console-border-soft)] bg-[var(--console-card-soft-bg)] px-3 py-2">
                  {commitDetail.files.length === 0 ? (
                    <div className="text-[10px] text-cafe-muted">No file changes</div>
                  ) : (
                    <div className="space-y-0.5">
                      {commitDetail.files.map((f) => (
                        <div key={f.path} className="flex items-center justify-between text-[10px] font-mono">
                          <span className="text-cafe-black/70 truncate">{f.path}</span>
                          <span className="ml-2 shrink-0 text-cafe-muted">{f.summary}</span>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              )}
            </div>
          ))}
          {commits.length === 0 && !loading && (
            <div className="px-3 py-4 text-center text-xs text-cafe-muted">No commits found</div>
          )}
        </div>
      </div>
    </div>
  );
}
