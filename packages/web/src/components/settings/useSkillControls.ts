'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { apiFetch } from '@/utils/api-client';
import type { CapabilityBoardItem, CapabilityBoardResponse, CatFamily } from '../capability-board-ui';
import { projectDisplayName } from '../ThreadSidebar/thread-utils';
import { readApiError } from './settings-utils';
import { useKnownProjects } from './useKnownProjects';

export { projectDisplayName };

type SkillCapabilityItem = CapabilityBoardItem & { type: 'skill' };
type CapabilityPatchDiscriminator = Pick<CapabilityBoardItem, 'source' | 'pluginId'>;

export function useSkillControls() {
  const [items, setItems] = useState<SkillCapabilityItem[]>([]);
  const [catFamilies, setCatFamilies] = useState<CatFamily[]>([]);
  const [loading, setLoading] = useState(true);
  const [projectPath, setProjectPath] = useState<string | null>(null);
  const [resolvedProjectPath, setResolvedProjectPath] = useState('');
  const [apiProjectPaths, setApiProjectPaths] = useState<string[]>([]);
  const [toggling, setToggling] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const fetchGeneration = useRef(0);
  const projectPathRef = useRef(projectPath);
  projectPathRef.current = projectPath;

  const knownProjects = useKnownProjects(apiProjectPaths);

  // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: generation-based race prevention (same pattern as useCapabilityState)
  const fetchItems = useCallback(async (forProject?: string) => {
    const generation = fetchGeneration.current + 1;
    fetchGeneration.current = generation;
    const isCurrent = () => fetchGeneration.current === generation;
    try {
      setError(null);
      const query = new URLSearchParams();
      if (forProject) query.set('projectPath', forProject);
      const queryString = query.toString();
      const res = await apiFetch(`/api/capabilities${queryString ? `?${queryString}` : ''}`);
      if (!isCurrent()) return;
      if (!res.ok) {
        const message = await readApiError(res as Response);
        if (!isCurrent()) return;
        setError(message);
        setItems([]);
        return;
      }
      const data = (await res.json()) as CapabilityBoardResponse;
      if (!isCurrent()) return;
      setItems(data.items.filter((item): item is SkillCapabilityItem => item.type === 'skill'));
      setCatFamilies(data.catFamilies);
      setApiProjectPaths(data.knownProjectPaths ?? []);
      // Only set resolvedProjectPath on initial load (no explicit project switch).
      // This preserves the "home" project in the ProjectSelector dropdown.
      if (!forProject) setResolvedProjectPath(data.projectPath);
    } catch {
      if (!isCurrent()) return;
      setError('能力数据加载失败');
      setItems([]);
    } finally {
      if (isCurrent()) setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchItems();
  }, [fetchItems]);

  const switchProject = useCallback(
    (path: string | null) => {
      setProjectPath(path);
      setItems([]);
      setCatFamilies([]);
      setLoading(true);
      fetchItems(path ?? undefined);
    },
    [fetchItems],
  );

  const handleToggle = useCallback(
    async (
      skillId: string,
      enabled: boolean,
      toggleScope: 'global' | 'project' = 'global',
      target?: CapabilityPatchDiscriminator,
    ) => {
      setError(null);
      setToggling(skillId);
      try {
        const projectContext = toggleScope === 'project' ? (projectPathRef.current ?? undefined) : undefined;
        // F228: "global" changes the global enabled state (+ cascades to all projects).
        // "project" mounts/unmounts for the selected project only.
        const body: Record<string, unknown> = {
          capabilityId: skillId,
          capabilityType: 'skill',
          scope: toggleScope,
          enabled,
          projectPath: projectContext,
        };
        if (target?.source) body.source = target.source;
        if (target?.pluginId) body.pluginId = target.pluginId;
        const res = await apiFetch('/api/capabilities', {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        });
        if (!res.ok) {
          setError(await readApiError(res as Response));
          return;
        }
        // F228: Check for propagation conflicts (partial success — non-conflicting
        // mount points mounted, conflicting ones skipped for user resolution).
        const data = (await res.json().catch(() => ({}))) as {
          propagationConflicts?: { projectPath: string; mountPoint: string }[];
        };
        const conflictCount = data.propagationConflicts?.length ?? 0;
        await fetchItems(projectContext);
        // Re-set after fetchItems (which clears error) so the message survives.
        if (conflictCount > 0) {
          setError(
            `启用成功，但 ${conflictCount} 个挂载冲突已跳过（目标路径已有用户自定义内容，可在 Skill 同步中处理）`,
          );
        }
      } catch {
        setError('网络错误');
      } finally {
        setToggling(null);
      }
    },
    [fetchItems],
  );

  // F228: batch toggle — enable/disable multiple skills in one request.
  // Uses capabilityIds[] so the API writes config once and runs syncProject once.
  const handleBatchToggle = useCallback(
    async (skillIds: string[], enabled: boolean, toggleScope: 'global' | 'project' = 'global') => {
      if (skillIds.length === 0) return;
      setError(null);
      setToggling('__batch__');
      try {
        const projectContext = toggleScope === 'project' ? (projectPathRef.current ?? undefined) : undefined;
        const body: Record<string, unknown> = {
          capabilityIds: skillIds,
          capabilityType: 'skill',
          scope: toggleScope,
          enabled,
          projectPath: projectContext,
        };
        const res = await apiFetch('/api/capabilities', {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        });
        if (!res.ok) {
          setError(await readApiError(res as Response));
          return;
        }
        const data = (await res.json().catch(() => ({}))) as {
          propagationConflicts?: { projectPath: string; mountPoint: string }[];
        };
        const conflictCount = data.propagationConflicts?.length ?? 0;
        await fetchItems(projectContext);
        if (conflictCount > 0) {
          setError(
            `批量操作成功，但 ${conflictCount} 个挂载冲突已跳过（目标路径已有用户自定义内容，可在 Skill 同步中处理）`,
          );
        }
      } catch {
        setError('网络错误');
      } finally {
        setToggling(null);
      }
    },
    [fetchItems],
  );

  // F228: per-mount-point toggle (scope from caller + mountPointId)
  const handleMountPointToggle = useCallback(
    async (
      skillId: string,
      mountPointId: string,
      enabled: boolean,
      toggleScope: 'global' | 'project' = 'project',
      target?: CapabilityPatchDiscriminator,
    ) => {
      setError(null);
      setToggling(`${skillId}:${mountPointId}`);
      try {
        const projectContext = toggleScope === 'project' ? (projectPathRef.current ?? undefined) : undefined;
        const body: Record<string, unknown> = {
          capabilityId: skillId,
          capabilityType: 'skill',
          scope: toggleScope,
          mountPointId,
          enabled,
          projectPath: projectContext,
        };
        if (target?.source) body.source = target.source;
        if (target?.pluginId) body.pluginId = target.pluginId;
        const res = await apiFetch('/api/capabilities', {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        });
        if (!res.ok) {
          setError(await readApiError(res as Response));
          return;
        }
        await fetchItems(projectContext);
      } catch {
        setError('网络错误');
      } finally {
        setToggling(null);
      }
    },
    [fetchItems],
  );

  const refetch = useCallback(
    (forProject?: string | null) => {
      // null = explicitly fetch global capabilities (no project context),
      // without resetting projectPath / resolvedProjectPath / items.
      if (forProject === null) return fetchItems(undefined);
      return fetchItems(forProject ?? projectPathRef.current ?? undefined);
    },
    [fetchItems],
  );

  return {
    items,
    catFamilies,
    loading,
    projectPath,
    resolvedProjectPath,
    knownProjects,
    toggling,
    error,
    switchProject,
    handleToggle,
    handleBatchToggle,
    handleMountPointToggle,
    refetch,
  };
}
