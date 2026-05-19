'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useChatStore } from '@/stores/chatStore';
import { apiFetch } from '@/utils/api-client';
import type { CapabilityBoardItem, CapabilityBoardResponse, CatFamily } from '../capability-board-ui';
import { getProjectPaths, projectDisplayName } from '../ThreadSidebar/thread-utils';

export { projectDisplayName };

type McpCapabilityBoardItem = CapabilityBoardItem & { type: 'mcp' };

async function readApiError(res: Response): Promise<string> {
  const data = (await res.json().catch(() => ({}))) as { error?: string };
  return data.error ?? `请求失败 (${res.status})`;
}

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

  const threads = useChatStore((state) => state.threads);
  const knownProjects = useMemo(() => getProjectPaths(threads), [threads]);

  const fetchItems = useCallback(
    async (forProject?: string) => {
      const generation = fetchGeneration.current + 1;
      fetchGeneration.current = generation;
      const isCurrent = () => fetchGeneration.current === generation;
      try {
        setError(null);
        const query = new URLSearchParams();
        if (forProject) query.set('projectPath', forProject);
        if (filterType === 'mcp') query.set('probe', 'true');
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
        const body: Record<string, unknown> = {
          capabilityId: item.id,
          capabilityType: 'mcp',
          scope: catId ? 'cat' : 'global',
          enabled,
          projectPath: projectPath ?? undefined,
        };
        if (catId) body.catId = catId;
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
