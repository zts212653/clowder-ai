'use client';

import { useEffect, useState } from 'react';
import type { RuntimeDrift, StaleBranch, WorktreeHealth } from '../../hooks/useGitHealth';
import { useGitHealth } from '../../hooks/useGitHealth';

function Badge({ label, variant }: { label: string; variant: 'danger' | 'warning' | 'success' | 'muted' }) {
  const colors = {
    danger: 'bg-conn-red-bg text-conn-red-text',
    warning: 'bg-conn-amber-bg text-conn-amber-text',
    success: 'bg-conn-emerald-bg text-conn-emerald-text',
    muted: 'bg-cafe-surface-elevated text-cafe-secondary',
  };
  return (
    <span className={`inline-block px-1 py-0.5 rounded text-[9px] font-mono font-bold ${colors[variant]}`}>
      {label}
    </span>
  );
}

function StaleBranchRow({ branch }: { branch: StaleBranch }) {
  const relDate = formatAge(branch.lastCommitDate);
  return (
    <div className="flex items-center gap-1.5 rounded px-1 py-0.5 text-xs font-mono hover:bg-[var(--console-hover-bg)]">
      <Badge label="stale" variant="warning" />
      <span className="truncate text-cafe-black/80 flex-1">{branch.name}</span>
      <span className="shrink-0 text-[10px] text-cafe-muted">{branch.author}</span>
      <span className="shrink-0 text-[10px] text-cafe-muted">{relDate}</span>
    </div>
  );
}

function WorktreeRow({ wt }: { wt: WorktreeHealth }) {
  const dirName = wt.path.split('/').pop() ?? wt.path;
  return (
    <div className="flex items-center gap-1.5 rounded px-1 py-0.5 text-xs font-mono hover:bg-[var(--console-hover-bg)]">
      <Badge label={wt.isOrphan ? 'orphan' : 'active'} variant={wt.isOrphan ? 'danger' : 'success'} />
      <span className="truncate text-cafe-black/80 flex-1">{dirName}</span>
      <span className="shrink-0 text-[10px] text-cafe-muted">{wt.branch}</span>
      <span className="shrink-0 text-[10px] text-cafe-muted">{wt.head}</span>
    </div>
  );
}

function DriftSection({ drift }: { drift: RuntimeDrift }) {
  if (!drift.available) {
    return <div className="px-1 text-[10px] text-cafe-muted">Runtime drift unavailable</div>;
  }
  const inSync = drift.aheadOfMain === 0 && drift.behindMain === 0;
  return (
    <div className="px-1 space-y-1">
      {inSync ? (
        <div className="flex items-center gap-1.5 text-xs">
          <Badge label="in sync" variant="success" />
          <span className="text-cafe-black/70">Runtime matches main</span>
        </div>
      ) : (
        <>
          {drift.behindMain > 0 && (
            <div className="space-y-0.5">
              <div className="flex items-center gap-1.5 text-xs">
                <Badge label={`-${drift.behindMain}`} variant="danger" />
                <span className="text-cafe-black/70">behind main ({drift.mainHead})</span>
              </div>
              {drift.behindCommits.length > 0 && (
                <div className="ml-6 space-y-0.5">
                  {drift.behindCommits.map((c) => (
                    <div key={c.short} className="flex items-center gap-1.5 text-[10px] font-mono text-cafe-black/60">
                      <span className="text-cafe-secondary">{c.short}</span>
                      <span className="truncate">{c.subject}</span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}
          {drift.aheadOfMain > 0 && (
            <div className="flex items-center gap-1.5 text-xs">
              <Badge label={`+${drift.aheadOfMain}`} variant="warning" />
              <span className="text-cafe-black/70">ahead of main ({drift.runtimeHead})</span>
            </div>
          )}
        </>
      )}
    </div>
  );
}

function formatAge(isoDate: string): string {
  const diff = Date.now() - new Date(isoDate).getTime();
  const days = Math.floor(diff / 86400000);
  if (days < 1) return 'today';
  if (days === 1) return '1d ago';
  return `${days}d ago`;
}

export function HealthDashboard() {
  const { health, loading, error, fetchHealth } = useGitHealth();
  const [collapsed, setCollapsed] = useState(false);

  useEffect(() => {
    fetchHealth();
  }, [fetchHealth]);

  if (!health && !loading && !error) return null;

  const staleCount = health?.staleBranches.length ?? 0;
  const orphanCount = health?.worktrees.filter((w) => w.isOrphan).length ?? 0;
  const totalIssues = staleCount + orphanCount;

  return (
    <div className="border-b border-[var(--console-border-soft)]">
      <button
        type="button"
        onClick={() => setCollapsed(!collapsed)}
        className="flex w-full items-center justify-between px-3 py-1.5 hover:bg-[var(--console-hover-bg)]"
      >
        <span className="text-[10px] font-semibold uppercase tracking-wider text-cafe-muted">
          Health {totalIssues > 0 ? `(${totalIssues} issues)` : ''}
        </span>
        <span className="text-[10px] text-cafe-muted">{collapsed ? '\u25b8' : '\u25be'}</span>
      </button>

      {!collapsed && (
        <div className="px-3 pb-2 space-y-2">
          {loading && <div className="text-[10px] text-cafe-muted">Loading...</div>}
          {error && <div className="text-xs text-conn-red-text">{error}</div>}

          {health && totalIssues === 0 && !health.runtimeDrift && (
            <div className="text-xs text-conn-emerald-text">All clean!</div>
          )}

          {staleCount > 0 && (
            <div>
              <div className="mb-1 text-[10px] font-semibold uppercase tracking-wider text-cafe-muted">
                Stale Branches ({staleCount})
              </div>
              <div className="space-y-0.5">
                {health?.staleBranches.map((b) => (
                  <StaleBranchRow key={b.name} branch={b} />
                ))}
              </div>
            </div>
          )}

          {health && health.worktrees.length > 0 && (
            <div>
              <div className="mb-1 text-[10px] font-semibold uppercase tracking-wider text-cafe-muted">
                Worktrees ({health.worktrees.length})
              </div>
              <div className="space-y-0.5">
                {health.worktrees.map((wt) => (
                  <WorktreeRow key={wt.path} wt={wt} />
                ))}
              </div>
            </div>
          )}

          {health?.runtimeDrift && <DriftSection drift={health.runtimeDrift} />}
        </div>
      )}
    </div>
  );
}
