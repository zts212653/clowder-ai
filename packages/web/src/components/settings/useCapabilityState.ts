import { useCallback, useEffect, useMemo, useState } from 'react';
import { useChatStore } from '@/stores/chatStore';
import { apiFetch } from '@/utils/api-client';
import type {
  CapabilityBoardItem,
  CapabilityBoardResponse,
  CatFamily,
  SkillHealthSummary,
} from '../capability-board-ui';
import { getProjectPaths, projectDisplayName } from '../ThreadSidebar/thread-utils';

export { projectDisplayName };

export function useCapabilityState(filterType: 'skill' | 'mcp') {
  const [items, setItems] = useState<CapabilityBoardItem[]>([]);
  const [catFamilies, setCatFamilies] = useState<CatFamily[]>([]);
  const [skillHealth, setSkillHealth] = useState<SkillHealthSummary | null>(null);
  const [loading, setLoading] = useState(true);
  const [projectPath, setProjectPath] = useState<string | null>(null);
  const [resolvedProjectPath, setResolvedProjectPath] = useState('');
  const [toggling, setToggling] = useState<string | null>(null);
  const [disabling, setDisabling] = useState<string | null>(null);

  const threads = useChatStore((s) => s.threads);
  const knownProjects = useMemo(() => getProjectPaths(threads), [threads]);

  const fetchItems = useCallback(
    async (forProject?: string) => {
      try {
        const query = new URLSearchParams();
        if (forProject) query.set('projectPath', forProject);
        if (filterType === 'mcp') query.set('probe', 'true');
        const res = await apiFetch(`/api/capabilities?${query.toString()}`);
        if (!res.ok) return;
        const data = (await res.json()) as CapabilityBoardResponse;
        setItems(data.items.filter((i) => i.type === filterType));
        setCatFamilies(data.catFamilies);
        setResolvedProjectPath(data.projectPath);
        setSkillHealth(data.skillHealth ?? null);
      } catch {
        /* ignore */
      } finally {
        setLoading(false);
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
      setToggling(key);
      try {
        const body: Record<string, unknown> = {
          capabilityId: item.id,
          capabilityType: filterType,
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
        if (res.ok) await fetchItems(projectPath ?? undefined);
      } catch {
        /* ignore */
      } finally {
        setToggling(null);
      }
    },
    [fetchItems, filterType, projectPath],
  );

  const handleRemoveMcp = useCallback(
    async (item: CapabilityBoardItem) => {
      setDisabling(item.id);
      try {
        const query = new URLSearchParams({ hard: 'true' });
        if (projectPath) query.set('projectPath', projectPath);
        const res = await apiFetch(`/api/capabilities/mcp/${encodeURIComponent(item.id)}?${query}`, {
          method: 'DELETE',
        });
        if (res.ok) await fetchItems(projectPath ?? undefined);
      } catch {
        /* ignore */
      } finally {
        setDisabling(null);
      }
    },
    [fetchItems, projectPath],
  );

  const handleDisableSkill = useCallback(
    async (item: CapabilityBoardItem) => {
      setDisabling(item.id);
      try {
        const query = new URLSearchParams();
        if (projectPath) query.set('projectPath', projectPath);
        const res = await apiFetch(`/api/capabilities/skill/${encodeURIComponent(item.id)}?${query}`, {
          method: 'DELETE',
        });
        if (res.ok) await fetchItems(projectPath ?? undefined);
      } catch {
        /* ignore */
      } finally {
        setDisabling(null);
      }
    },
    [fetchItems, projectPath],
  );

  return {
    items,
    catFamilies,
    skillHealth,
    loading,
    projectPath,
    resolvedProjectPath,
    knownProjects,
    toggling,
    disabling,
    switchProject,
    handleToggle,
    handleRemoveMcp,
    handleDisableSkill,
    refetch: () => fetchItems(projectPath ?? undefined),
  };
}
