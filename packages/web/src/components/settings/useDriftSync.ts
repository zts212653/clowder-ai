'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { apiFetch } from '@/utils/api-client';
import type { DriftCheckResult, DriftIssue, DriftType, ScopeIssues } from './drift-types';

const GLOBAL_SCOPE_KEY = 'global';

interface UseDriftSyncOptions {
  /** Capability type: 'skill' or 'mcp'. */
  type: DriftType;
  /** Known project paths (from useKnownProjects). */
  projectPaths: string[];
  /** The currently resolved project path (server default). */
  resolvedProjectPath?: string;
  /** Increment to force re-fetch of scope reports. */
  refreshToken?: number;
  /** Whether to fetch (only when scope = all-projects). */
  enabled?: boolean;
}

function visibleIssues(drift: DriftCheckResult | null): DriftIssue[] {
  return drift?.issues ?? [];
}

/**
 * Unified drift sync hook — drives both "全部 X" (all-projects) and
 * per-project drift banners for Skills and MCP via the same endpoint.
 *
 * F249: Same check function, same endpoint (/api/drift/check),
 * differentiated only by the `type` parameter.
 */
export function useDriftSync({
  type,
  projectPaths: rawProjectPaths,
  resolvedProjectPath,
  refreshToken = 0,
  enabled = true,
}: UseDriftSyncOptions) {
  const [syncing, setSyncing] = useState(false);
  const [syncAllError, setSyncAllError] = useState<string | null>(null);
  const [scopeDrift, setScopeDrift] = useState<Record<string, DriftCheckResult>>({});
  const reportsFetchGen = useRef(0);

  // F249: Exclude resolvedProjectPath (the main/startup project) from per-project
  // drift checks. The main project is already checked as the global scope via
  // driftFor(undefined) → checkGlobal. Including it again would duplicate global
  // issues (mount-missing, unregistered) as project-level sync issues, making
  // every skill badge show "待同步" even when projects are correctly synced.
  const projectPaths = useMemo(() => {
    const normalize = (p: string) => p.replace(/\/+$/, '');
    const resolvedNorm = resolvedProjectPath ? normalize(resolvedProjectPath) : null;
    const paths = new Set<string>();
    for (const path of rawProjectPaths) {
      if (path && path !== 'default' && (!resolvedNorm || normalize(path) !== resolvedNorm)) {
        paths.add(path);
      }
    }
    return Array.from(paths);
  }, [rawProjectPaths, resolvedProjectPath]);
  const projectPathsKey = projectPaths.join('\0');

  /** Call /api/drift/check for one scope. */
  const driftFor = useCallback(
    async (projectPath?: string): Promise<DriftCheckResult> => {
      const res = await apiFetch('/api/drift/check', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ type, projectPath: projectPath ?? undefined }),
      });
      if (!res.ok) throw new Error(`${type} 异常检测失败 (${res.status})`);
      const payload = (await res.json()) as { result?: DriftCheckResult };
      return payload.result ?? { issues: [], driftHash: '' };
    },
    [type],
  );

  /** Fetch drift reports for global + every project scope. */
  const fetchScopeReports = useCallback(
    async (paths: string[]) => {
      const generation = ++reportsFetchGen.current;
      const isCurrent = () => reportsFetchGen.current === generation;
      const [globalDrift, projectDrifts] = await Promise.all([
        driftFor(undefined),
        // Per-project: catch individually so one invalid/stale project doesn't
        // kill the entire batch. A failed project shows as a synthetic issue
        // instead of silently hiding all drift results.
        Promise.all(
          paths.map(async (path) => {
            try {
              return [path, await driftFor(path)] as const;
            } catch (err) {
              const label = path.split('/').pop() ?? path;
              const msg = err instanceof Error ? err.message : '检测失败';
              const failIssue: DriftIssue = {
                id: '__check-failed',
                issueType: 'check-failed',
                message: `项目 ${label} 异常检测失败: ${msg}`,
              };
              return [path, { issues: [failIssue], driftHash: '' } as DriftCheckResult] as const;
            }
          }),
        ),
      ]);
      if (!isCurrent()) return;
      setScopeDrift({ [GLOBAL_SCOPE_KEY]: globalDrift, ...Object.fromEntries(projectDrifts) });
    },
    [driftFor],
  );

  // biome-ignore lint/correctness/useExhaustiveDependencies: refreshToken is a parent-driven refetch signal.
  useEffect(() => {
    if (!enabled) return;
    const paths = projectPathsKey ? projectPathsKey.split('\0').filter(Boolean) : [];
    setSyncAllError(null);
    void fetchScopeReports(paths).catch((err) => {
      setSyncAllError(err instanceof Error ? err.message : '跨项目状态加载失败');
    });
  }, [fetchScopeReports, projectPathsKey, enabled, refreshToken]);

  /** Scope tree: global first, then each project. */
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

  const scopesWithIssues = useMemo(() => scopeIssues.filter((s) => s.issues.length > 0), [scopeIssues]);

  const projectConsistency = useMemo(() => {
    const totalProjects = projectPaths.length;
    const syncedProjects = projectPaths.filter((path) => visibleIssues(scopeDrift[path] ?? null).length === 0).length;
    return { totalProjects, syncedProjects };
  }, [projectPaths, scopeDrift]);

  /** Resolve drift for one scope. */
  const resolveScope = useCallback(
    async (action: 'sync', projectPath?: string) => {
      const res = await apiFetch('/api/drift/resolve', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ type, action, projectPath: projectPath ?? undefined }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(body.error ?? `Sync failed (${res.status})`);
      }
    },
    [type],
  );

  const handleSyncScope = useCallback(
    async (projectPath?: string) => {
      setSyncing(true);
      setSyncAllError(null);
      try {
        await resolveScope('sync', projectPath);
        await fetchScopeReports(projectPaths);
      } catch (err) {
        setSyncAllError(err instanceof Error ? err.message : '同步失败');
      } finally {
        setSyncing(false);
      }
    },
    [fetchScopeReports, projectPaths, resolveScope],
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
      await fetchScopeReports(projectPaths);
    } catch (err) {
      setSyncAllError(err instanceof Error ? err.message : '全部同步失败');
    } finally {
      setSyncing(false);
    }
  }, [fetchScopeReports, projectPaths, resolveScope]);

  return {
    syncing,
    syncAllError,
    projectPaths,
    projectConsistency,
    scopeIssues,
    scopesWithIssues,
    scopeDrift,
    handleSyncAllScopes,
    handleSyncScope,
  };
}
