'use client';

import { useEffect, useState } from 'react';
import type { RuntimeDrift, StaleBranch, WorktreeHealth } from '../../hooks/useGitHealth';
import { useGitHealth } from '../../hooks/useGitHealth';

function Badge({ label, variant }: { label: string; variant: 'danger' | 'warning' | 'success' | 'muted' }) {
  const colors = {
    danger: 'bg-red-100 text-red-700',
    warning: 'bg-amber-100 text-amber-700',
    success: 'bg-green-100 text-green-700',
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
    <div className="flex items-center gap-1.5 text-xs font-mono py-0.5 px-1 rounded hover:bg-cocreator-light/30">
      <Badge label="stale" variant="warning" />
      <span className="truncate text-cafe-black/80 flex-1">{branch.name}</span>
      <span className="text-[10px] text-cocreator-dark/40 shrink-0">{branch.author}</span>
      <span className="text-[10px] text-cocreator-dark/30 shrink-0">{relDate}</span>
    </div>
  );
}

function WorktreeRow({ wt }: { wt: WorktreeHealth }) {
  const dirName = wt.path.split('/').pop() ?? wt.path;
  return (
    <div className="flex items-center gap-1.5 text-xs font-mono py-0.5 px-1 rounded hover:bg-cocreator-light/30">
      <Badge label={wt.isOrphan ? 'orphan' : 'active'} variant={wt.isOrphan ? 'danger' : 'success'} />
      <span className="truncate text-cafe-black/80 flex-1">{dirName}</span>
      <span className="text-[10px] text-cocreator-dark/40 shrink-0">{wt.branch}</span>
      <span className="text-[10px] text-cocreator-dark/30 shrink-0">{wt.head}</span>
    </div>
  );
}

function DriftSection({ drift }: { drift: RuntimeDrift }) {
  if (!drift.available) {
    return <div className="text-[10px] text-cocreator-dark/40 px-1">Runtime drift unavailable</div>;
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
                      <span className="text-cocreator-primary/50">{c.short}</span>
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
    <div className="border-b border-cocreator-light/40">
      <button
        type="button"
        onClick={() => setCollapsed(!collapsed)}
        className="w-full flex items-center justify-between px-3 py-1.5 hover:bg-cocreator-light/20"
      >
        <span className="text-[10px] font-semibold text-cocreator-dark/60 uppercase tracking-wider">
          Health {totalIssues > 0 ? `(${totalIssues} issues)` : ''}
        </span>
        <span className="text-[10px] text-cocreator-dark/40">{collapsed ? '\u25b8' : '\u25be'}</span>
      </button>

      {!collapsed && (
        <div className="px-3 pb-2 space-y-2">
          {loading && <div className="text-[10px] text-cocreator-dark/40">Loading...</div>}
          {error && <div className="text-xs text-red-600">{error}</div>}

          {health && totalIssues === 0 && !health.runtimeDrift && (
            <div className="text-xs text-green-600">All clean!</div>
          )}

          {staleCount > 0 && (
            <div>
              <div className="text-[10px] font-semibold text-cocreator-dark/50 uppercase tracking-wider mb-1">
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
              <div className="text-[10px] font-semibold text-cocreator-dark/50 uppercase tracking-wider mb-1">
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
