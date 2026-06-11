'use client';

import { useCallback, useEffect, useState } from 'react';
import { SettingsBadge, SettingsText } from './primitives';

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
 * F228: Redesigned to match SkillsDriftBanner pattern (same amber card + modal popup)
 * so that 全部 Skill and 项目 Skill tabs have consistent UX for anomaly alerts.
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
  const [open, setOpen] = useState(false);
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const hasDetails = projectDetails && projectDetails.length > 0;

  const handleBackdrop = useCallback((e: React.MouseEvent) => {
    if (e.target === e.currentTarget) setOpen(false);
  }, []);

  useEffect(() => {
    if (!open) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [open]);
  const issueCount = projectCount - syncedProjects;
  const allConsistent = syncedProjects === projectCount && projectCount > 0;

  // No projects or all consistent → success state
  if (projectCount === 0) {
    return <p className="text-xs text-cafe-muted">未发现项目</p>;
  }
  if (allConsistent) {
    return <p className="text-xs text-cafe-muted">✓ 全部项目 Skill 同步一致</p>;
  }

  // Build issue summary line
  const summaryParts: string[] = [];
  if (hasDetails) {
    const mountMissing = projectDetails.filter((p) => !p.allMounted).length;
    const regInconsistent = projectDetails.filter((p) => !p.registrationConsistent).length;
    const staleCount = projectDetails.filter((p) => p.stale).length;
    const driftNew = projectDetails.reduce((sum, p) => sum + p.driftNew, 0);
    const driftConflicts = projectDetails.reduce((sum, p) => sum + p.driftConflicts, 0);
    const driftStale = projectDetails.reduce((sum, p) => sum + p.driftStale, 0);
    if (mountMissing > 0) summaryParts.push(`${mountMissing} 挂载缺失`);
    if (regInconsistent > 0) summaryParts.push(`${regInconsistent} 注册不一致`);
    if (staleCount > 0) summaryParts.push(`${staleCount} 版本过期`);
    if (driftNew > 0) summaryParts.push(`${driftNew} 待挂载`);
    if (driftConflicts > 0) summaryParts.push(`${driftConflicts} 挂载冲突`);
    if (driftStale > 0) summaryParts.push(`${driftStale} 残留待清`);
  }
  if (summaryParts.length === 0) summaryParts.push(`${syncedProjects}/${projectCount} 项目一致`);

  return (
    <div className="rounded-2xl border border-conn-amber-ring bg-conn-amber-bg shadow-[0_12px_30px_rgba(43,33,26,0.08)]">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center justify-between px-4 py-3 text-left"
      >
        <div>
          <p className="text-sm font-bold text-conn-amber-text">⚠ 检测到 {issueCount} 个项目 Skill 异常</p>
          <p className="mt-0.5 text-xs text-cafe-secondary">{summaryParts.join(' · ')}</p>
        </div>
        <span className="text-xs text-cafe-muted">查看详情</span>
      </button>
      {open && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-[var(--console-overlay-backdrop)] px-4 backdrop-blur-sm"
          role="dialog"
          onClick={handleBackdrop}
        >
          <div
            className="max-h-[80vh] w-full max-w-2xl overflow-auto rounded-xl bg-[var(--console-card-bg)] p-5 shadow-xl"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="mb-4 flex items-center justify-between gap-4">
              <div>
                <p className="text-base font-bold text-cafe">项目 Skill 同步详情</p>
                <p className="text-xs text-cafe-secondary">
                  {issueCount} 个项目存在 Skill 异常，{syncedProjects} 个项目一致。
                </p>
              </div>
              <button
                type="button"
                onClick={() => setOpen(false)}
                aria-label="关闭"
                className="flex h-8 w-8 shrink-0 items-center justify-center rounded-xl text-base font-bold leading-none text-cafe-muted transition hover:bg-[var(--console-modal-close-bg)] hover:text-[var(--console-modal-close-fg)]"
              >
                ×
              </button>
            </div>

            {error && <p className="mb-2 text-xs text-conn-red-text">⚠ {error}</p>}

            {hasDetails && (
              <div className="space-y-2">
                {projectDetails.map((project) => {
                  const ok =
                    project.allMounted &&
                    project.registrationConsistent &&
                    !project.stale &&
                    project.driftNew === 0 &&
                    project.driftConflicts === 0 &&
                    project.driftStale === 0;
                  const issues: string[] = [];
                  if (!project.allMounted) issues.push('挂载缺失');
                  if (!project.registrationConsistent) issues.push('注册不一致');
                  if (project.stale) issues.push('版本过期');
                  if (project.driftNew > 0) issues.push(`${project.driftNew} 待挂载`);
                  if (project.driftConflicts > 0) issues.push(`${project.driftConflicts} 挂载冲突`);
                  if (project.driftStale > 0) issues.push(`${project.driftStale} 残留待清`);
                  const skillIssues =
                    !ok && project.skillIssues && project.skillIssues.length > 0 ? project.skillIssues : null;
                  const isExpanded = expanded[project.path] ?? false;
                  return (
                    <div key={project.path} className="rounded-lg hover:bg-[var(--console-hover-bg)] transition-colors">
                      <div className="flex items-center justify-between px-3 py-2.5">
                        <button
                          type="button"
                          className="flex items-center gap-2 text-left"
                          disabled={!skillIssues}
                          onClick={() =>
                            skillIssues && setExpanded((prev) => ({ ...prev, [project.path]: !prev[project.path] }))
                          }
                        >
                          {skillIssues && (
                            <span
                              className={`text-[10px] text-cafe-muted transition-transform ${isExpanded ? 'rotate-90' : ''}`}
                            >
                              ▶
                            </span>
                          )}
                          <SettingsBadge tone={ok ? 'emerald' : 'amber'} size="xxs">
                            {ok ? '一致' : '异常'}
                          </SettingsBadge>
                          <SettingsText tone="secondary" className="text-xs font-medium">
                            {project.displayName}
                          </SettingsText>
                          {!ok && (
                            <SettingsText tone="muted" className="text-xs">
                              {issues.join(' · ')}
                              {skillIssues ? ` · ${skillIssues.length} 件待修` : ''}
                            </SettingsText>
                          )}
                        </button>
                        {!ok && onSyncProject && (
                          <button
                            type="button"
                            onClick={() => onSyncProject(project.path)}
                            disabled={syncing}
                            className="shrink-0 rounded-lg px-2.5 py-1 text-xs font-medium text-cafe-accent hover:bg-[var(--console-hover-bg)] disabled:opacity-50"
                          >
                            同步此项目
                          </button>
                        )}
                      </div>
                      {isExpanded && skillIssues && (
                        <div className="ml-6 rounded-lg bg-[var(--console-panel-bg)] px-3 py-2 space-y-1">
                          {skillIssues.map((si) => (
                            <div key={si.name} className="flex items-baseline gap-2 text-xs">
                              <span className="shrink-0 text-cafe-muted">·</span>
                              <span className="font-medium text-cafe-secondary">{si.name}</span>
                              <span className="text-cafe-muted">{si.issues.join('、')}</span>
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            )}

            <div className="mt-4 flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setOpen(false)}
                className="rounded-xl px-3 py-1.5 text-xs text-cafe-secondary hover:bg-[var(--console-hover-bg)]"
              >
                关闭
              </button>
              <button
                type="button"
                onClick={() => {
                  onSyncAll();
                  setOpen(false);
                }}
                disabled={syncing}
                className="rounded-xl bg-cafe-accent px-3 py-1.5 text-xs font-semibold text-[var(--cafe-accent-foreground)] hover:bg-cafe-accent-hover disabled:opacity-40"
              >
                {syncing ? '同步中…' : '同步全部项目'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
