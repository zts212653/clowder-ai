'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useChatStore } from '@/stores/chatStore';
import { apiFetch } from '@/utils/api-client';
import type { CapabilityBoardItem, CapabilityBoardResponse, CatFamily } from '../capability-board-ui';
import { getProjectPaths, projectDisplayName } from '../ThreadSidebar/thread-utils';

export { projectDisplayName };

type SkillCapabilityItem = CapabilityBoardItem & { type: 'skill' };

async function readApiError(res: Response): Promise<string> {
  const data = (await res.json().catch(() => ({}))) as { error?: string };
  return data.error ?? `请求失败 (${res.status})`;
}

export function useSkillControls() {
  const [items, setItems] = useState<SkillCapabilityItem[]>([]);
  const [catFamilies, setCatFamilies] = useState<CatFamily[]>([]);
  const [loading, setLoading] = useState(true);
  const [projectPath, setProjectPath] = useState<string | null>(null);
  const [resolvedProjectPath, setResolvedProjectPath] = useState('');
  const [toggling, setToggling] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const fetchGeneration = useRef(0);
  const projectPathRef = useRef(projectPath);
  projectPathRef.current = projectPath;

  const threads = useChatStore((state) => state.threads);
  const knownProjects = useMemo(() => getProjectPaths(threads), [threads]);

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
      setResolvedProjectPath(data.projectPath);
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
    async (skillId: string, enabled: boolean, catId?: string) => {
      const key = catId ? `${skillId}:${catId}` : skillId;
      setError(null);
      setToggling(key);
      try {
        const body: Record<string, unknown> = {
          capabilityId: skillId,
          capabilityType: 'skill',
          scope: catId ? 'cat' : 'global',
          enabled,
          projectPath: projectPathRef.current ?? undefined,
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
        await fetchItems(projectPathRef.current ?? undefined);
      } catch {
        setError('网络错误');
      } finally {
        setToggling(null);
      }
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
    refetch: () => fetchItems(projectPathRef.current ?? undefined),
  };
}
