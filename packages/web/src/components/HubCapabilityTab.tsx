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
import { CapabilityAuditLog } from './CapabilityAuditLog';
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
import { McpConfigModal } from './McpConfigModal';
import { getProjectPaths, projectDisplayName } from './ThreadSidebar/thread-utils';

type FilterSource = 'all' | 'cat-cafe' | 'external';
type FilterLayer = 'all' | 'L1' | 'L2' | 'L3';

interface HubCapabilityTabProps {
  section?: 'all' | 'mcp' | 'skills';
}

export function HubCapabilityTab({ section = 'all' }: HubCapabilityTabProps) {
  const [items, setItems] = useState<CapabilityBoardItem[]>([]);
  const [catFamilies, setCatFamilies] = useState<CatFamily[]>([]);
  const [skillHealth, setSkillHealth] = useState<SkillHealthSummary | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [filterSource, setFilterSource] = useState<FilterSource>('all');
  const [filterLayer, setFilterLayer] = useState<FilterLayer>('all');
  const [toggling, setToggling] = useState<string | null>(null);
  const [showMcpModal, setShowMcpModal] = useState(false);
  const [editMcpId, setEditMcpId] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<string | null>(null);

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

  const handleDeleteMcp = useCallback(
    async (capId: string, hard: boolean) => {
      setDeleting(capId);
      try {
        const query = new URLSearchParams();
        if (hard) query.set('hard', 'true');
        if (projectPath) query.set('projectPath', projectPath);
        const res = await apiFetch(`/api/capabilities/mcp/${encodeURIComponent(capId)}?${query}`, {
          method: 'DELETE',
        });
        if (!res.ok) {
          const data = (await res.json().catch(() => ({}))) as Record<string, string>;
          setError(data.error ?? `删除失败 (${res.status})`);
          return;
        }
        await fetchCapabilities(projectPath ?? undefined);
      } catch {
        setError('网络错误');
      } finally {
        setDeleting(null);
      }
    },
    [fetchCapabilities, projectPath],
  );

  // Filter + group
  const filtered = useMemo(() => {
    let result = items;
    if (filterSource !== 'all') result = result.filter((i) => i.source === filterSource);
    if (filterLayer !== 'all') result = result.filter((i) => i.layer === filterLayer);
    return result;
  }, [items, filterSource, filterLayer]);

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

  if (loading) return <p className="text-sm text-cafe-muted">加载中...</p>;

  return (
    <div className="space-y-6">
      {error && (
        <div className="console-status-chip" data-status="error">
          {error}
        </div>
      )}

      {/* Header: project + filters */}
      <div className="flex flex-wrap items-center justify-between gap-3">
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
        <FilterChips
          label="层级"
          value={filterLayer}
          options={[
            { value: 'all', label: '全部' },
            { value: 'L1', label: 'L1 MCP' },
            { value: 'L2', label: 'L2 Skill' },
            { value: 'L3', label: 'L3 扩展' },
          ]}
          onChange={(v) => setFilterLayer(v as FilterLayer)}
        />
      </div>

      {/* Skill health banner — only relevant in skills/all view */}
      {skillHealth && section !== 'mcp' && <SkillHealthBanner health={skillHealth} items={items} />}

      {/* MCP Section */}
      {(section === 'all' || section === 'mcp') && (
        <div className="space-y-4">
          <div className="flex items-center justify-end">
            <button type="button" onClick={() => setShowMcpModal(true)} className="console-button-secondary">
              + 添加 MCP
            </button>
          </div>

          {(showMcpModal || editMcpId) && (
            <McpConfigModal
              projectPath={projectPath ?? undefined}
              editId={editMcpId ?? undefined}
              editData={editMcpId ? mcpItems.find((i) => i.id === editMcpId)?.mcpServer : undefined}
              onSaved={() => fetchCapabilities(projectPath ?? undefined)}
              onClose={() => {
                setShowMcpModal(false);
                setEditMcpId(null);
              }}
            />
          )}

          <CapabilitySection
            icon={<SectionIconMcp />}
            title="MCP"
            subtitle="工具服务"
            items={mcpItems}
            catFamilies={catFamilies}
            toggling={toggling}
            onToggle={handleToggle}
            onDeleteMcp={handleDeleteMcp}
            deletingMcp={deleting}
            onEditMcp={(id) => setEditMcpId(id)}
          />
        </div>
      )}

      {/* Clowder AI Skills by Category */}
      {(section === 'all' || section === 'skills') &&
        catCafeSkillGroups.map((group) => (
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
      {(section === 'all' || section === 'skills') && (
        <CapabilitySection
          icon={<SectionIconExtension />}
          title="Extensions"
          subtitle="外部扩展 Skills"
          items={externalSkills}
          catFamilies={catFamilies}
          toggling={toggling}
          onToggle={handleToggle}
        />
      )}

      {(section === 'mcp'
        ? mcpItems.length === 0
        : section === 'skills'
          ? catCafeSkillGroups.length === 0 && externalSkills.length === 0
          : filtered.length === 0) && (
        <div className="flex flex-col items-center justify-center rounded-xl bg-[var(--console-card-bg)] py-16 text-center">
          <div className="mb-4 flex h-20 w-20 items-center justify-center rounded-full bg-[var(--console-card-soft-bg)]">
            <svg
              className="h-8 w-8 text-cafe-muted"
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
          <h3 className="text-sm font-semibold text-cafe-secondary">没有找到匹配的能力</h3>
          <p className="mt-1 max-w-[220px] text-xs text-cafe-muted">试着切换来源筛选，或检查 MCP/Skills 配置</p>
        </div>
      )}

      {/* Audit log */}
      <CapabilityAuditLog projectPath={projectPath ?? undefined} />

      {/* Summary */}
      <div className="console-card-soft mt-4 rounded-xl px-4 py-3">
        <div className="flex items-center justify-between text-xs text-cafe-muted">
          <span>共 {items.length} 项</span>
          <span className="flex gap-3">
            <span className="flex items-center gap-1.5">
              <StatusDot status="connected" /> {items.filter((i) => i.connectionStatus === 'connected').length} 活跃
            </span>
            <span>
              MCP:{' '}
              <strong className="font-medium text-cafe-secondary">
                {items.filter((i) => i.type === 'mcp').length}
              </strong>
            </span>
            <span>
              Skill:{' '}
              <strong className="font-medium text-cafe-secondary">
                {items.filter((i) => i.type === 'skill').length}
              </strong>
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
      <div className="flex items-center gap-1.5 text-xs text-cafe-muted">
        <span>项目:</span>
        <span className="console-pill rounded-full px-3 py-1 font-medium text-cafe-secondary">
          {projectDisplayName(resolvedPath)}
        </span>
      </div>
    );
  }

  return (
    <div className="flex items-center gap-2 text-xs">
      <label htmlFor="project-select" className="text-cafe-muted whitespace-nowrap">
        项目:
      </label>
      <select
        id="project-select"
        value={currentSelection ?? ''}
        onChange={(e) => onSwitch(e.target.value || null)}
        className="console-form-input min-w-0 flex-1 truncate py-2 text-xs"
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
