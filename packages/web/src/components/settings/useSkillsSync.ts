'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { apiFetch } from '@/utils/api-client';
import type { ScopeIssues } from './AllProjectsSyncBanner';
import type { SkillIssue } from './skill-issue-view';
import type { SettingsSkillItem, SkillProjectSyncSummary, SkillScope, SkillsData } from './skills-types';
import { SCOPE_ALL } from './skills-types';
import type { useSkillControls } from './useSkillControls';

interface DriftResult {
  issues: SkillIssue[];
  driftHash: string;
}

const GLOBAL_SCOPE_KEY = 'global';

interface UseSkillsSyncOptions {
  scope: SkillScope;
  data: SkillsData | null;
  composedItems: SettingsSkillItem[];
  controls: ReturnType<typeof useSkillControls>;
  fetchSkills: (forProject?: string) => Promise<void>;
  /** Increment to force re-fetch of scope reports (e.g. after skill toggle). */
  refreshToken?: number;
}

function visibleIssues(drift: DriftResult | null): SkillIssue[] {
  return drift?.issues ?? [];
}

export function useSkillsSync({ scope, composedItems, controls, fetchSkills, refreshToken = 0 }: UseSkillsSyncOptions) {
  const [syncing, setSyncing] = useState(false);
  const [syncAllError, setSyncAllError] = useState<string | null>(null);
  // Keyed by scope key: GLOBAL_SCOPE_KEY for global, project path otherwise.
  const [scopeDrift, setScopeDrift] = useState<Record<string, DriftResult>>({});
  const reportsFetchGen = useRef(0);

  const selectedProjectPath = controls.projectPath || controls.resolvedProjectPath || undefined;
  const latestScopeRef = useRef(scope);
  latestScopeRef.current = scope;

  const knownProjectsKey = controls.knownProjects.join('\0');
  const knownProjectPaths = useMemo(
    () => (knownProjectsKey ? knownProjectsKey.split('\0').filter(Boolean) : []),
    [knownProjectsKey],
  );

  const projectPaths = useMemo(() => {
    const paths = new Set<string>();
    for (const path of knownProjectPaths) {
      if (path && path !== 'default') paths.add(path);
    }
    if (controls.resolvedProjectPath && controls.resolvedProjectPath !== 'default')
      paths.add(controls.resolvedProjectPath);
    return Array.from(paths);
  }, [controls.resolvedProjectPath, knownProjectPaths]);
  const projectPathsKey = projectPaths.join('\0');

  /** Fetch backend-computed issues for global + every project scope. */
  const fetchScopeReports = useCallback(async (paths: string[]) => {
    const generation = ++reportsFetchGen.current;
    const isCurrent = () => reportsFetchGen.current === generation;
    const driftFor = async (projectPath?: string): Promise<DriftResult> => {
      const res = await apiFetch('/api/skills/drift-check', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(projectPath ? { projectPath } : {}),
      });
      if (!res.ok) throw new Error(`Skill 异常检测失败 (${res.status})`);
      const payload = (await res.json()) as { result?: DriftResult };
      return payload.result ?? { issues: [], driftHash: '' };
    };
    const [globalDrift, projectDrifts] = await Promise.all([
      driftFor(undefined),
      Promise.all(paths.map(async (path) => [path, await driftFor(path)] as const)),
    ]);
    if (!isCurrent()) return;
    setScopeDrift({ [GLOBAL_SCOPE_KEY]: globalDrift, ...Object.fromEntries(projectDrifts) });
  }, []);

  // biome-ignore lint/correctness/useExhaustiveDependencies: refreshToken is a parent-driven refetch signal.
  useEffect(() => {
    if (scope !== SCOPE_ALL) return;
    const paths = projectPathsKey ? projectPathsKey.split('\0').filter(Boolean) : [];
    setSyncAllError(null);
    void fetchScopeReports(paths).catch((err) => {
      setSyncAllError(err instanceof Error ? err.message : '跨项目 Skill 状态加载失败');
    });
  }, [fetchScopeReports, projectPathsKey, scope, refreshToken]);

  /** Scope tree: /global first, then each project, each carrying its issue list. */
  const scopeIssues: ScopeIssues[] = useMemo(() => {
    const projectName = (path: string) => {
      const parts = path.replace(/\/+$/, '').split('/');
      return parts[parts.length - 1] || path;
    };
    const scopes: ScopeIssues[] = [
      { key: GLOBAL_SCOPE_KEY, label: '全局', issues: visibleIssues(scopeDrift[GLOBAL_SCOPE_KEY] ?? null) },
    ];
    for (const path of projectPaths) {
      scopes.push({ key: path, label: projectName(path), path, issues: visibleIssues(scopeDrift[path] ?? null) });
    }
    return scopes;
  }, [projectPaths, scopeDrift]);

  /** Scopes (global + projects) that currently have anomalies — drives the banner + dialog. */
  const scopesWithIssues = useMemo(() => scopeIssues.filter((s) => s.issues.length > 0), [scopeIssues]);

  const projectConsistency = useMemo(() => {
    const totalProjects = projectPaths.length;
    const syncedProjects = projectPaths.filter((path) => visibleIssues(scopeDrift[path] ?? null).length === 0).length;
    return { totalProjects, syncedProjects };
  }, [projectPaths, scopeDrift]);

  /** Per-skill cross-project sync badge: a skill is synced in a project iff that
   *  project's issue list does not reference it. */
  const skillProjectSync = useMemo(() => {
    const totalProjects = projectPaths.length;
    const loaded = projectPaths.every((path) => scopeDrift[path] !== undefined);
    const map = new Map<string, SkillProjectSyncSummary>();
    for (const skill of composedItems) {
      const syncedProjects = projectPaths.filter((path) => {
        const issues = visibleIssues(scopeDrift[path] ?? null);
        return !issues.some((issue) => issue.skill === skill.name);
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
  }, [composedItems, projectPaths, scopeDrift]);

  const resolveScope = useCallback(async (action: 'sync' | 'ignore', projectPath?: string) => {
    const res = await apiFetch('/api/skills/drift-resolve', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(projectPath ? { action, projectPath } : { action }),
    });
    if (!res.ok) {
      const body = (await res.json().catch(() => ({}))) as { error?: string };
      throw new Error(body.error ?? `Sync failed (${res.status})`);
    }
  }, []);

  const refreshAfterSync = useCallback(async () => {
    const refreshProjectPath = latestScopeRef.current === SCOPE_ALL ? undefined : selectedProjectPath;
    await Promise.all([
      fetchSkills(refreshProjectPath),
      controls.refetch(latestScopeRef.current === SCOPE_ALL ? null : refreshProjectPath),
      fetchScopeReports(projectPaths),
    ]);
  }, [controls, fetchScopeReports, fetchSkills, projectPaths, selectedProjectPath]);

  const handleSyncScope = useCallback(
    async (projectPath?: string) => {
      setSyncing(true);
      setSyncAllError(null);
      try {
        await resolveScope('sync', projectPath);
        await refreshAfterSync();
      } catch (err) {
        setSyncAllError(err instanceof Error ? err.message : '同步失败');
      } finally {
        setSyncing(false);
      }
    },
    [refreshAfterSync, resolveScope],
  );

  const handleSyncAllScopes = useCallback(async () => {
    setSyncing(true);
    setSyncAllError(null);
    try {
      // Global first so cascade config reaches projects, then each project.
      await resolveScope('sync', undefined);
      for (const path of projectPaths) {
        await resolveScope('sync', path);
      }
      await refreshAfterSync();
    } catch (err) {
      setSyncAllError(err instanceof Error ? err.message : 'Sync all scopes failed');
    } finally {
      setSyncing(false);
    }
  }, [projectPaths, refreshAfterSync, resolveScope]);

  return {
    syncing,
    syncAllError,
    projectPaths,
    projectConsistency,
    scopeIssues,
    scopesWithIssues,
    skillProjectSync,
    handleSyncAllScopes,
    handleSyncScope,
  };
}
