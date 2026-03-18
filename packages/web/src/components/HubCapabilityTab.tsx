'use client';

/**
 * HubCapabilityTab — F041 统一能力中心
 *
 * 卡片式手风琴布局，MCP + Skills 合并。
 * 全局开关 + 展开后 per-cat 开关（按猫族折叠）。
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useChatStore } from '@/stores/chatStore';
import { apiFetch } from '@/utils/api-client';
import type {
  CapabilityBoardItem,
  CapabilityBoardResponse,
  CatFamily,
  SkillHealthSummary,
  ToggleHandler,
} from './capability-board-ui';
import {
  CapabilitySection,
  FilterChips,
  SectionIconExtension,
  SectionIconMcp,
  SectionIconSkill,
  SkillHealthBanner,
  StatusDot,
} from './capability-board-ui';
import { getProjectPaths, projectDisplayName } from './ThreadSidebar/thread-utils';

type FilterSource = 'all' | 'cat-cafe' | 'external';

export function HubCapabilityTab() {
  const [items, setItems] = useState<CapabilityBoardItem[]>([]);
  const [catFamilies, setCatFamilies] = useState<CatFamily[]>([]);
  const [skillHealth, setSkillHealth] = useState<SkillHealthSummary | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [filterSource, setFilterSource] = useState<FilterSource>('all');
  const [toggling, setToggling] = useState<string | null>(null);

  // Multi-project state
  const [projectPath, setProjectPath] = useState<string | null>(null);
  const [resolvedProjectPath, setResolvedProjectPath] = useState<string>('');

  const threads = useChatStore((s) => s.threads);
  const knownProjects = useMemo(() => getProjectPaths(threads), [threads]);

  const fetchCapabilities = useCallback(async (forProject?: string) => {
    setError(null);
    try {
      const query = new URLSearchParams();
      if (forProject) query.set('projectPath', forProject);
      query.set('probe', 'true');
      const res = await apiFetch(`/api/capabilities?${query.toString()}`);
      if (!res.ok) {
        const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
        setError((data.error as string) ?? '加载失败');
        return;
      }
      const data = (await res.json()) as CapabilityBoardResponse;
      setItems(data.items);
      setCatFamilies(data.catFamilies);
      setResolvedProjectPath(data.projectPath);
      setSkillHealth(data.skillHealth ?? null);
    } catch {
      setError('网络错误');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchCapabilities();
  }, [fetchCapabilities]);

  const switchProject = useCallback(
    (path: string | null) => {
      setProjectPath(path);
      setLoading(true);
      fetchCapabilities(path ?? undefined);
    },
    [fetchCapabilities],
  );

  const handleToggle: ToggleHandler = useCallback(
    async (capabilityId, capabilityType, enabled, scope = 'global', catId) => {
      const toggleKey = catId ? `${capabilityType}:${capabilityId}:${catId}` : `${capabilityType}:${capabilityId}`;
      setToggling(toggleKey);
      try {
        const body: Record<string, unknown> = {
          capabilityId,
          capabilityType,
          scope,
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
          const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
          setError((data.error as string) ?? `开关失败 (${res.status})`);
          return;
        }
        await fetchCapabilities(projectPath ?? undefined);
      } catch {
        setError('网络错误');
      } finally {
        setToggling(null);
      }
    },
    [fetchCapabilities, projectPath],
  );

  // Filter + group
  const filtered = useMemo(() => {
    if (filterSource === 'all') return items;
    return items.filter((i) => i.source === filterSource);
  }, [items, filterSource]);

  const mcpItems = useMemo(() => filtered.filter((i) => i.type === 'mcp'), [filtered]);
  const externalSkills = useMemo(
    () => filtered.filter((i) => i.type === 'skill' && i.source === 'external'),
    [filtered],
  );

  // Group Clowder AI Skills by category (from BOOTSTRAP.md)
  const catCafeSkillGroups = useMemo(() => {
    const catCafe = filtered.filter((i) => i.type === 'skill' && i.source === 'cat-cafe');
    const groups: { category: string; items: CapabilityBoardItem[] }[] = [];
    const categoryMap = new Map<string, CapabilityBoardItem[]>();
    const categoryOrder: string[] = [];
    for (const item of catCafe) {
      const cat = item.category ?? '未分类';
      let arr = categoryMap.get(cat);
      if (!arr) {
        arr = [];
        categoryMap.set(cat, arr);
        categoryOrder.push(cat);
      }
      arr.push(item);
    }
    for (const cat of categoryOrder) {
      groups.push({ category: cat, items: categoryMap.get(cat)! });
    }
    return groups;
  }, [filtered]);

  if (loading) return <p className="text-sm text-gray-400">加载中...</p>;

  return (
    <div className="space-y-4">
      {error && <p className="text-sm text-red-500 bg-red-50 rounded-lg px-3 py-2">{error}</p>}

      {/* Header: project + filters */}
      <div className="flex flex-wrap items-center gap-3">
        <ProjectSelector
          resolvedPath={resolvedProjectPath}
          knownProjects={knownProjects}
          currentSelection={projectPath}
          onSwitch={switchProject}
        />
        <FilterChips
          label="来源"
          value={filterSource}
          options={[
            { value: 'all', label: '全部' },
            { value: 'cat-cafe', label: 'Clowder AI' },
            { value: 'external', label: '外部' },
          ]}
          onChange={(v) => setFilterSource(v as FilterSource)}
        />
      </div>

      {/* Skill health banner */}
      {skillHealth && <SkillHealthBanner health={skillHealth} items={items} />}

      {/* MCP Section */}
      <CapabilitySection
        icon={<SectionIconMcp />}
        title="MCP"
        subtitle="工具服务"
        items={mcpItems}
        catFamilies={catFamilies}
        toggling={toggling}
        onToggle={handleToggle}
      />

      {/* Clowder AI Skills by Category */}
      {catCafeSkillGroups.map((group) => (
        <CapabilitySection
          key={group.category}
          icon={<SectionIconSkill />}
          title={group.category}
          subtitle="Clowder AI Skills"
          items={group.items}
          catFamilies={catFamilies}
          toggling={toggling}
          onToggle={handleToggle}
        />
      ))}

      {/* External Skills Section */}
      <CapabilitySection
        icon={<SectionIconExtension />}
        title="Extensions"
        subtitle="外部扩展 Skills"
        items={externalSkills}
        catFamilies={catFamilies}
        toggling={toggling}
        onToggle={handleToggle}
      />

      {filtered.length === 0 && (
        <div className="flex flex-col items-center justify-center py-16 text-center">
          <div className="w-20 h-20 bg-slate-50 rounded-full flex items-center justify-center mb-4">
            <svg
              className="w-8 h-8 text-slate-300"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.5"
              strokeLinecap="round"
            >
              <circle cx="11" cy="11" r="8" />
              <path d="m21 21-4.35-4.35" />
            </svg>
          </div>
          <h3 className="text-sm font-semibold text-slate-600">没有找到匹配的能力</h3>
          <p className="text-xs text-slate-400 mt-1 max-w-[220px]">试着切换来源筛选，或检查 MCP/Skills 配置</p>
        </div>
      )}

      {/* Summary */}
      <div className="pt-4 border-t border-slate-100/60 mt-4">
        <div className="flex items-center justify-between text-xs text-slate-400">
          <span>共 {items.length} 项</span>
          <span className="flex gap-3">
            <span className="flex items-center gap-1.5">
              <StatusDot status="connected" /> {items.filter((i) => i.connectionStatus === 'connected').length} 活跃
            </span>
            <span>
              MCP:{' '}
              <strong className="text-slate-500 font-medium">{items.filter((i) => i.type === 'mcp').length}</strong>
            </span>
            <span>
              Skill:{' '}
              <strong className="text-slate-500 font-medium">{items.filter((i) => i.type === 'skill').length}</strong>
            </span>
          </span>
        </div>
      </div>
    </div>
  );
}

// ────────── Project Selector ──────────

function ProjectSelector({
  resolvedPath,
  knownProjects,
  currentSelection,
  onSwitch,
}: {
  resolvedPath: string;
  knownProjects: string[];
  currentSelection: string | null;
  onSwitch: (path: string | null) => void;
}) {
  const allPaths = useMemo(() => {
    const set = new Set<string>();
    set.add(resolvedPath);
    for (const p of knownProjects) set.add(p);
    return Array.from(set);
  }, [resolvedPath, knownProjects]);

  if (allPaths.length <= 1) {
    return (
      <div className="text-xs text-gray-400 flex items-center gap-1.5">
        <span>项目:</span>
        <span className="text-gray-600 font-medium">{projectDisplayName(resolvedPath)}</span>
      </div>
    );
  }

  return (
    <div className="flex items-center gap-2 text-xs">
      <label htmlFor="project-select" className="text-gray-400 whitespace-nowrap">
        项目:
      </label>
      <select
        id="project-select"
        value={currentSelection ?? ''}
        onChange={(e) => onSwitch(e.target.value || null)}
        className="flex-1 min-w-0 px-2 py-1 rounded border border-gray-200 bg-white text-gray-700 text-xs truncate"
      >
        <option value="">{projectDisplayName(resolvedPath)}</option>
        {allPaths
          .filter((p) => p !== resolvedPath || currentSelection !== null)
          .map((path) => (
            <option key={path} value={path}>
              {projectDisplayName(path)}
            </option>
          ))}
      </select>
    </div>
  );
}
