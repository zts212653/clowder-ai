'use client';

/** Per-skill issue entry for the expandable project detail */
export interface ProjectSkillIssue {
  name: string;
  issues: string[];
}

/** Per-project sync status for the expandable detail view */
export interface ProjectSyncDetail {
  path: string;
  displayName: string;
  allMounted: boolean;
  registrationConsistent: boolean;
  stale: boolean;
  driftNew: number;
  driftConflicts: number;
  driftStale: number;
  /** Per-skill breakdown (populated when data available) */
  skillIssues?: ProjectSkillIssue[];
}

/**
 * AllProjectsSyncBanner — 全部 Skill tab 的跨项目同步状态横幅。
 *
 * F228: Simple list format — no modal, no hover, no highlight.
 */
export function AllProjectsSyncBanner({
  projectCount,
  syncedProjects,
  syncing,
  error,
  onSyncAll,
  projectDetails,
  onSyncProject,
}: {
  projectCount: number;
  syncedProjects: number;
  syncing: boolean;
  error: string | null;
  onSyncAll: () => void;
  projectDetails?: ProjectSyncDetail[];
  onSyncProject?: (projectPath: string) => void;
}) {
  const issueCount = projectCount - syncedProjects;
  const allConsistent = syncedProjects === projectCount && projectCount > 0;

  if (projectCount === 0) {
    return <p className="text-xs text-cafe-muted">未发现项目</p>;
  }
  if (allConsistent) {
    return <p className="text-xs text-cafe-muted">✓ 全部项目 Skill 同步一致</p>;
  }

  // Build flat issue list per project
  const projectIssues: Array<{ project: string; path: string; issues: string[] }> = [];
  if (projectDetails) {
    for (const p of projectDetails) {
      const issues: string[] = [];
      if (!p.allMounted) issues.push('挂载缺失');
      if (!p.registrationConsistent) issues.push('注册不一致');
      if (p.stale) issues.push('版本过期');
      if (p.driftNew > 0) issues.push(`${p.driftNew} 待挂载`);
      if (p.driftConflicts > 0) issues.push(`${p.driftConflicts} 挂载冲突`);
      if (p.driftStale > 0) issues.push(`${p.driftStale} 残留待清`);
      // Per-skill breakdown
      if (p.skillIssues) {
        for (const si of p.skillIssues) {
          issues.push(`${si.issues.join('、')} - ${si.name}`);
        }
      }
      if (issues.length > 0) {
        projectIssues.push({ project: p.displayName, path: p.path, issues });
      }
    }
  }

  return (
    <div className="rounded-lg border border-conn-amber-ring bg-conn-amber-bg px-4 py-3">
      <p className="text-sm font-bold text-conn-amber-text">⚠ {issueCount} 个项目 Skill 异常</p>

      {error && <p className="mt-1 text-xs text-conn-red-text">⚠ {error}</p>}

      {projectIssues.length > 0 && (
        <div className="mt-2 space-y-2">
          {projectIssues.map(({ project, path, issues }) => (
            <div key={path}>
              <div className="flex items-center gap-2">
                <span className="text-xs font-medium text-cafe-secondary">{project}</span>
                {onSyncProject && (
                  <button
                    type="button"
                    onClick={() => onSyncProject(path)}
                    disabled={syncing}
                    className="text-xs text-cafe-accent hover:underline disabled:opacity-50"
                  >
                    同步
                  </button>
                )}
              </div>
              <ul className="mt-0.5 space-y-0.5 text-xs text-cafe-muted">
                {issues.map((issue) => (
                  <li key={`${path}:${issue}`}>{issue}</li>
                ))}
              </ul>
            </div>
          ))}
        </div>
      )}

      {projectIssues.length === 0 && (
        <p className="mt-1 text-xs text-cafe-muted">
          {syncedProjects}/{projectCount} 项目一致
        </p>
      )}

      <div className="mt-3">
        <button
          type="button"
          onClick={onSyncAll}
          disabled={syncing}
          className="rounded-lg bg-cafe-accent px-3 py-1 text-xs font-semibold text-[var(--cafe-accent-foreground)] hover:bg-cafe-accent-hover disabled:opacity-40"
        >
          {syncing ? '同步中…' : '同步全部项目'}
        </button>
      </div>
    </div>
  );
}
