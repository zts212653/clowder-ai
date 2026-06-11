'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { apiFetch } from '@/utils/api-client';
import type { ProjectSkillIssue, ProjectSyncDetail } from './AllProjectsSyncBanner';
import type { SettingsSkillItem, SkillProjectSyncSummary, SkillScope, SkillsApiData, SkillsData } from './skills-types';
import { normalizeSkillsData, SCOPE_ALL } from './skills-types';
import type { useSkillControls } from './useSkillControls';

interface ProjectDriftResult {
  newSkills: string[];
  conflicts: Array<{ skill: string }>;
  stale: string[];
  isIgnored: boolean;
}

interface ProjectReport {
  data: SkillsData;
  drift: ProjectDriftResult | null;
}

type ProjectReportEntry = ProjectReport & { path: string };

interface UseSkillsSyncOptions {
  scope: SkillScope;
  data: SkillsData | null;
  composedItems: SettingsSkillItem[];
  controls: ReturnType<typeof useSkillControls>;
  fetchSkills: (forProject?: string) => Promise<void>;
}

export function useSkillsSync({ scope, data, composedItems, controls, fetchSkills }: UseSkillsSyncOptions) {
  const [syncing, setSyncing] = useState(false);
  const [syncAllError, setSyncAllError] = useState<string | null>(null);
  const [projectReports, setProjectReports] = useState<Record<string, ProjectReport>>({});
  const reportsFetchGen = useRef(0);

  const selectedProjectPath = controls.projectPath || controls.resolvedProjectPath || undefined;
  const latestScopeRef = useRef(scope);
  latestScopeRef.current = scope;
  const latestSelectedProjectPathRef = useRef(selectedProjectPath);
  latestSelectedProjectPathRef.current = selectedProjectPath;

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

  const fetchProjectReports = useCallback(async (paths: string[]) => {
    const generation = ++reportsFetchGen.current;
    const isCurrent = () => reportsFetchGen.current === generation;
    const entries = await Promise.all(
      paths.map(async (path) => {
        const [skillsRes, driftRes] = await Promise.all([
          apiFetch(`/api/skills?projectPath=${encodeURIComponent(path)}`),
          apiFetch('/api/skills/drift-check', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ projectPath: path }),
          }),
        ]);
        if (!skillsRes.ok) throw new Error(`Skills 数据加载失败 (${skillsRes.status})`);
        if (!driftRes.ok) throw new Error(`Skill 异常检测失败 (${driftRes.status})`);
        const driftPayload = (await driftRes.json()) as { result?: ProjectDriftResult };
        return [
          path,
          {
            data: normalizeSkillsData((await skillsRes.json()) as SkillsApiData),
            drift: driftPayload.result ?? null,
          },
        ] as const;
      }),
    );
    if (!isCurrent()) return;
    setProjectReports(Object.fromEntries(entries));
  }, []);

  useEffect(() => {
    const paths = projectPathsKey ? projectPathsKey.split('\0').filter(Boolean) : [];
    if (scope !== SCOPE_ALL || paths.length === 0) return;
    setSyncAllError(null);
    void fetchProjectReports(paths).catch((err) => {
      setSyncAllError(err instanceof Error ? err.message : '跨项目 Skill 状态加载失败');
    });
  }, [fetchProjectReports, projectPathsKey, scope]);

  const projectReportEntries = useMemo(() => {
    const entries = projectPaths
      .map((path) => {
        const report = projectReports[path];
        return report ? ({ path, ...report } as const) : null;
      })
      .filter(Boolean) as ProjectReportEntry[];
    if (entries.length === 0 && data) {
      return [{ path: selectedProjectPath ?? '当前项目', data, drift: null }];
    }
    return entries;
  }, [data, projectPaths, projectReports, selectedProjectPath]);

  const projectConsistency = useMemo(() => {
    const totalProjects = projectPaths.length || projectReportEntries.length || (data ? 1 : 0);
    const syncedProjects = projectReportEntries.filter(({ data: report, drift }) => {
      const visibleDrift = drift?.isIgnored ? null : drift;
      return (
        report.summary.allMounted &&
        report.summary.registrationConsistent &&
        !(report.staleness?.stale ?? false) &&
        (visibleDrift?.newSkills.length ?? 0) === 0 &&
        (visibleDrift?.conflicts.length ?? 0) === 0 &&
        (visibleDrift?.stale.length ?? 0) === 0
      );
    }).length;
    return { totalProjects, syncedProjects };
  }, [data, projectPaths.length, projectReportEntries]);

  const projectSyncDetails: ProjectSyncDetail[] = useMemo(() => {
    return projectReportEntries.map(({ path, data: report, drift }) => {
      const parts = path.replace(/\/+$/, '').split('/');
      const visibleDrift = drift?.isIgnored ? null : drift;

      // Build per-skill issue breakdown
      const skillMap = new Map<string, string[]>();
      const addIssue = (name: string, issue: string) => {
        const existing = skillMap.get(name);
        if (existing) existing.push(issue);
        else skillMap.set(name, [issue]);
      };
      // Mount missing
      for (const skill of report.skills) {
        const mounted = skill.mountHealth?.allMounted ?? Object.values(skill.mounts).every(Boolean);
        if (!mounted) addIssue(skill.name, '挂载缺失');
      }
      // Registration staleness
      if (report.staleness) {
        for (const name of report.staleness.newSkills) addIssue(name, '新增待注册');
        for (const name of report.staleness.removedSkills) addIssue(name, '已移除');
      }
      // Drift
      if (visibleDrift) {
        for (const name of visibleDrift.newSkills) addIssue(name, '待挂载');
        for (const c of visibleDrift.conflicts) addIssue(c.skill, '挂载冲突');
        for (const name of visibleDrift.stale) addIssue(name, '残留待清');
      }
      const skillIssues: ProjectSkillIssue[] = Array.from(skillMap, ([name, issues]) => ({ name, issues }));

      return {
        path,
        displayName: parts[parts.length - 1] || path,
        allMounted: report.summary.allMounted,
        registrationConsistent: report.summary.registrationConsistent,
        stale: report.staleness?.stale ?? false,
        driftNew: visibleDrift?.newSkills.length ?? 0,
        driftConflicts: visibleDrift?.conflicts.length ?? 0,
        driftStale: visibleDrift?.stale.length ?? 0,
        skillIssues: skillIssues.length > 0 ? skillIssues : undefined,
      };
    });
  }, [projectReportEntries]);

  const skillProjectSync = useMemo(() => {
    const totalProjects = projectPaths.length || projectReportEntries.length || (data ? 1 : 0);
    const map = new Map<string, SkillProjectSyncSummary>();
    for (const skill of composedItems) {
      const syncedProjects = projectReportEntries.filter(({ data: report, drift }) => {
        const projectSkill = report.skills.find((s) => s.name === skill.name);
        if (!projectSkill) return false;
        const allMounted =
          projectSkill.mountHealth?.allMounted ??
          Object.values(projectSkill.mounts).every((mounted) => mounted === true);
        const isStaleNew = report.staleness?.newSkills.includes(skill.name) ?? false;
        const isStaleRemoved = report.staleness?.removedSkills.includes(skill.name) ?? false;
        const visibleDrift = drift?.isIgnored ? null : drift;
        const isDriftNew = visibleDrift?.newSkills.includes(skill.name) ?? false;
        const isDriftConflict = visibleDrift?.conflicts.some((conflict) => conflict.skill === skill.name) ?? false;
        const isDriftStale = visibleDrift?.stale.includes(skill.name) ?? false;
        return allMounted && !isStaleNew && !isStaleRemoved && !isDriftNew && !isDriftConflict && !isDriftStale;
      }).length;
      const status: SkillProjectSyncSummary['status'] =
        projectReportEntries.length < totalProjects
          ? 'unknown'
          : syncedProjects === totalProjects
            ? 'all'
            : syncedProjects > 0
              ? 'partial'
              : 'none';
      map.set(skill.name, { totalProjects, syncedProjects, status });
    }
    return map;
  }, [composedItems, data, projectPaths.length, projectReportEntries]);

  const handleSyncSingleProject = useCallback(
    async (projectPath: string) => {
      setSyncing(true);
      setSyncAllError(null);
      try {
        const res = await apiFetch('/api/skills/sync', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ projectPath }),
        });
        if (!res.ok) {
          const body = (await res.json().catch(() => ({}))) as { error?: string };
          throw new Error(body.error ?? `Sync failed (${res.status})`);
        }
        const refreshProjectPath =
          latestScopeRef.current === SCOPE_ALL ? undefined : latestSelectedProjectPathRef.current;
        await Promise.all([
          fetchSkills(refreshProjectPath),
          controls.refetch(latestScopeRef.current === SCOPE_ALL ? null : refreshProjectPath),
          fetchProjectReports(projectPaths),
        ]);
      } catch (err) {
        setSyncAllError(err instanceof Error ? err.message : '同步失败');
      } finally {
        setSyncing(false);
      }
    },
    [controls, fetchProjectReports, fetchSkills, projectPaths],
  );

  const handleSyncAllProjects = useCallback(async () => {
    const paths = projectPaths.length > 0 ? projectPaths : selectedProjectPath ? [selectedProjectPath] : [];
    if (paths.length === 0) return;
    setSyncing(true);
    setSyncAllError(null);
    try {
      for (const path of paths) {
        const res = await apiFetch('/api/skills/sync', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ projectPath: path }),
        });
        if (!res.ok) {
          const body = (await res.json().catch(() => ({}))) as { error?: string };
          throw new Error(body.error ?? `Sync failed (${res.status})`);
        }
      }
      const refreshProjectPath =
        latestScopeRef.current === SCOPE_ALL ? undefined : latestSelectedProjectPathRef.current;
      await Promise.all([
        fetchSkills(refreshProjectPath),
        controls.refetch(latestScopeRef.current === SCOPE_ALL ? null : refreshProjectPath),
        fetchProjectReports(paths),
      ]);
    } catch (err) {
      setSyncAllError(err instanceof Error ? err.message : 'Sync all projects failed');
    } finally {
      setSyncing(false);
    }
  }, [controls, fetchProjectReports, fetchSkills, projectPaths, selectedProjectPath]);

  return {
    syncing,
    syncAllError,
    projectPaths,
    projectConsistency,
    projectSyncDetails,
    skillProjectSync,
    handleSyncAllProjects,
    handleSyncSingleProject,
  };
}
