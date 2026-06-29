'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { apiFetch } from '@/utils/api-client';
import type { CapabilityBoardItem, CapabilityBoardResponse, CatFamily } from '../capability-board-ui';
import { projectDisplayName } from '../ThreadSidebar/thread-utils';
import { readApiError } from './settings-utils';
import { useKnownProjects } from './useKnownProjects';

export { projectDisplayName };

type McpCapabilityBoardItem = CapabilityBoardItem & { type: 'mcp' };

export function useCapabilityState(filterType: 'mcp' = 'mcp') {
  const [items, setItems] = useState<McpCapabilityBoardItem[]>([]);
  const [catFamilies, setCatFamilies] = useState<CatFamily[]>([]);
  const [loading, setLoading] = useState(true);
  const [projectPath, setProjectPath] = useState<string | null>(null);
  const [resolvedProjectPath, setResolvedProjectPath] = useState('');
  const [toggling, setToggling] = useState<string | null>(null);
  const [disabling, setDisabling] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const fetchGeneration = useRef(0);

  const [serverKnownProjects, setServerKnownProjects] = useState<string[]>([]);
  const knownProjects = useKnownProjects(serverKnownProjects);

  const fetchItems = useCallback(
    async (forProject?: string) => {
      const generation = fetchGeneration.current + 1;
      fetchGeneration.current = generation;
      const isCurrent = () => fetchGeneration.current === generation;
      try {
        setError(null);
        const query = new URLSearchParams();
        if (forProject) query.set('projectPath', forProject);
        // F249 §8.4: MCP list must NOT probe tools — lazy load in modal instead.
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
        setItems(data.items.filter((item): item is McpCapabilityBoardItem => item.type === 'mcp'));
        setCatFamilies(data.catFamilies);
        setResolvedProjectPath(data.projectPath);
        if (data.knownProjectPaths) setServerKnownProjects(data.knownProjectPaths);
      } catch {
        if (!isCurrent()) return;
        setError('网络错误');
        setItems([]);
      } finally {
        if (isCurrent()) setLoading(false);
      }
    },
    [filterType],
  );

  useEffect(() => {
    fetchItems();
  }, [fetchItems]);

  const switchProject = useCallback(
    (path: string | null) => {
      setProjectPath(path);
      setLoading(true);
      fetchItems(path ?? undefined);
    },
    [fetchItems],
  );

  const handleToggle = useCallback(
    async (item: CapabilityBoardItem, enabled: boolean, catId?: string) => {
      const key = catId ? `${item.id}:${catId}` : item.id;
      setError(null);
      setToggling(key);
      try {
        // F249: project tab toggles must use scope='project' so backend writes blockedCats.
        // Per-cat toggle on project tab: scope='project' + mountPointId=catId.
        // Global tab: scope='global' (whole) or scope='cat' (per-cat).
        const isProjectScope = !!projectPath;
        const scope = isProjectScope ? 'project' : catId ? 'cat' : 'global';
        const body: Record<string, unknown> = {
          capabilityId: item.id,
          capabilityType: 'mcp',
          source: item.source,
          pluginId: item.pluginId,
          scope,
          enabled,
          projectPath: projectPath ?? undefined,
        };
        if (isProjectScope && catId) body.mountPointId = catId;
        else if (catId) body.catId = catId;
        const res = await apiFetch('/api/capabilities', {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        });
        if (!res.ok) {
          setError(await readApiError(res as Response));
          return;
        }
        await fetchItems(projectPath ?? undefined);
      } catch {
        setError('网络错误');
      } finally {
        setToggling(null);
      }
    },
    [fetchItems, projectPath],
  );

  const handleRemoveMcp = useCallback(
    async (item: CapabilityBoardItem) => {
      setError(null);
      setDisabling(item.id);
      try {
        const query = new URLSearchParams();
        if (projectPath) query.set('projectPath', projectPath);
        if (item.source === 'external') query.set('hard', 'true');
        const queryString = query.toString();
        const res = await apiFetch(`/api/capabilities/mcp/${encodeURIComponent(item.id)}?${queryString}`, {
          method: 'DELETE',
        });
        if (!res.ok) {
          setError(await readApiError(res as Response));
          return;
        }
        await fetchItems(projectPath ?? undefined);
      } catch {
        setError('网络错误');
      } finally {
        setDisabling(null);
      }
    },
    [fetchItems, projectPath],
  );

  return {
    items,
    catFamilies,
    loading,
    projectPath,
    resolvedProjectPath,
    knownProjects,
    toggling,
    disabling,
    error,
    setError,
    switchProject,
    handleToggle,
    handleRemoveMcp,
    refetch: () => fetchItems(projectPath ?? undefined),
  };
}
