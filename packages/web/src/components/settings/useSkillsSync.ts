'use client';

import { useMemo } from 'react';
import type { DriftIssue } from './drift-types';
import type { SettingsSkillItem, SkillProjectSyncSummary, SkillScope, SkillsData } from './skills-types';
import { SCOPE_ALL } from './skills-types';
import { useDriftSync } from './useDriftSync';
import type { useSkillControls } from './useSkillControls';

interface UseSkillsSyncOptions {
  scope: SkillScope;
  data: SkillsData | null;
  composedItems: SettingsSkillItem[];
  controls: ReturnType<typeof useSkillControls>;
  fetchSkills: (forProject?: string) => Promise<void>;
  /** Increment to force re-fetch of scope reports (e.g. after skill toggle). */
  refreshToken?: number;
}

function visibleIssues(drift: { issues: DriftIssue[] } | undefined | null): DriftIssue[] {
  return drift?.issues ?? [];
}

/**
 * Skill-specific sync hook — wraps the unified useDriftSync with
 * the per-skill cross-project sync badge computation (skillProjectSync).
 *
 * F249: Core drift logic delegates to useDriftSync({ type: 'skill' }).
 */
export function useSkillsSync({ scope, composedItems, controls, refreshToken = 0 }: UseSkillsSyncOptions) {
  const drift = useDriftSync({
    type: 'skill',
    projectPaths: controls.knownProjects,
    resolvedProjectPath: controls.resolvedProjectPath,
    refreshToken,
    // Gate on !loading so drift-check waits for the capability list to settle
    // (same guard applied to MCP in McpManageContent — see fix/712 commit).
    enabled: scope === SCOPE_ALL && !controls.loading,
  });

  /** Per-skill cross-project sync badge: a skill is synced in a project iff that
   *  project's issue list does not reference it (by DriftIssue.id = skill name). */
  const skillProjectSync = useMemo(() => {
    const { projectPaths, scopeDrift } = drift;
    const totalProjects = projectPaths.length;
    const loaded = projectPaths.every((path) => scopeDrift[path] !== undefined);
    const map = new Map<string, SkillProjectSyncSummary>();
    for (const skill of composedItems) {
      const syncedProjects = projectPaths.filter((path) => {
        const issues = visibleIssues(scopeDrift[path]);
        return !issues.some((issue) => issue.id === skill.name);
      }).length;
      const status: SkillProjectSyncSummary['status'] = !loaded
        ? 'unknown'
        : totalProjects === 0 || syncedProjects === totalProjects
          ? 'all'
          : syncedProjects > 0
            ? 'partial'
            : 'none';
      map.set(skill.name, { totalProjects, syncedProjects, status });
    }
    return map;
  }, [composedItems, drift]);

  return {
    ...drift,
    skillProjectSync,
  };
}
