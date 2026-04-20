'use client';

import { useCallback, useEffect, useState } from 'react';
import { useToastStore } from '@/stores/toastStore';
import { apiFetch } from '@/utils/api-client';
import { HubIcon } from './hub-icons';

interface SkillMount {
  claude: boolean;
  codex: boolean;
  gemini: boolean;
  kimi: boolean;
}

interface SkillEntry {
  name: string;
  category: string;
  trigger: string;
  mounts: SkillMount;
  requiresMcp?: { id: string; status: 'ready' | 'missing' | 'unresolved' }[];
}

interface SkillsSummary {
  total: number;
  allMounted: boolean;
  registrationConsistent: boolean;
}

interface SkillsStaleness {
  stale: boolean;
  currentHash: string;
  recordedHash: string | null;
  newSkills: string[];
  removedSkills: string[];
}

interface SkillConflict {
  skillName: string;
  projectTarget: string;
  userTarget: string;
  activeLayer: 'user' | 'project';
}

interface SkillsData {
  skills: SkillEntry[];
  summary: SkillsSummary;
  staleness: SkillsStaleness | null;
  conflicts: SkillConflict[];
}

function MountBadge({ mounted }: { mounted: boolean }) {
  return mounted ? (
    <span className="inline-flex items-center justify-center w-5 h-5 rounded-full bg-green-100 text-green-600">
      <HubIcon name="check" className="h-3 w-3" />
    </span>
  ) : (
    <span className="inline-flex items-center justify-center w-5 h-5 rounded-full bg-red-100 text-red-500">
      <HubIcon name="x" className="h-3 w-3" />
    </span>
  );
}

function CategoryGroup({ category, skills }: { category: string; skills: SkillEntry[] }) {
  return (
    <section className="rounded-lg border border-cafe bg-cafe-surface-elevated/70 p-3">
      <h3 className="text-xs font-semibold text-cafe-secondary mb-2">{category}</h3>
      <div className="overflow-x-auto">
        <table className="w-full text-xs">
          <thead>
            <tr className="text-left text-[10px] text-cafe-muted uppercase tracking-wide">
              <th className="pb-1.5 pr-3 font-semibold">Skill</th>
              <th className="pb-1.5 pr-3 font-semibold">触发条件</th>
              <th className="pb-1.5 pr-3 font-semibold">MCP 依赖</th>
              <th className="pb-1.5 w-12 text-center font-semibold">Claude</th>
              <th className="pb-1.5 w-12 text-center font-semibold">Codex</th>
              <th className="pb-1.5 w-12 text-center font-semibold">Gemini</th>
              <th className="pb-1.5 w-12 text-center font-semibold">Kimi</th>
            </tr>
          </thead>
          <tbody>
            {skills.map((skill) => (
              <tr key={skill.name} className="border-t border-cafe-subtle">
                <td className="py-1.5 pr-3">
                  <code className="font-mono text-blue-600 bg-blue-50 px-1.5 py-0.5 rounded text-[11px]">
                    {skill.name}
                  </code>
                </td>
                <td className="py-1.5 pr-3 text-cafe-secondary max-w-[260px] truncate">{skill.trigger}</td>
                <td className="py-1.5 pr-3">
                  <div className="flex flex-wrap gap-1">
                    {(skill.requiresMcp ?? []).length === 0 ? (
                      <span className="text-[11px] text-cafe-muted">—</span>
                    ) : (
                      skill.requiresMcp?.map((dep) => (
                        <span
                          key={`${skill.name}:${dep.id}`}
                          className={`inline-flex items-center rounded-full px-2 py-0.5 text-[10px] font-semibold ${
                            dep.status === 'ready'
                              ? 'bg-emerald-100 text-emerald-700'
                              : dep.status === 'missing'
                                ? 'bg-rose-100 text-rose-700'
                                : 'bg-amber-100 text-amber-700'
                          }`}
                        >
                          {dep.id}:{dep.status}
                        </span>
                      ))
                    )}
                  </div>
                </td>
                <td className="py-1.5 text-center">
                  <MountBadge mounted={skill.mounts.claude} />
                </td>
                <td className="py-1.5 text-center">
                  <MountBadge mounted={skill.mounts.codex} />
                </td>
                <td className="py-1.5 text-center">
                  <MountBadge mounted={skill.mounts.gemini} />
                </td>
                <td className="py-1.5 text-center">
                  <MountBadge mounted={skill.mounts.kimi} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function StaleBanner({
  staleness,
  onSync,
  syncing,
}: {
  staleness: SkillsStaleness;
  onSync: () => void;
  syncing: boolean;
}) {
  if (!staleness.stale) return null;
  const hasNew = staleness.newSkills.length > 0;
  const hasRemoved = staleness.removedSkills.length > 0;

  return (
    <div className="rounded-lg border border-blue-200 bg-blue-50 p-3 text-xs">
      <div className="flex items-center justify-between">
        <div className="text-blue-800">
          <span className="font-semibold">Skills 有更新</span>
          {hasNew && <span className="ml-2">+{staleness.newSkills.length} 新增</span>}
          {hasRemoved && <span className="ml-2">-{staleness.removedSkills.length} 移除</span>}
        </div>
        <button
          type="button"
          onClick={onSync}
          disabled={syncing}
          className="rounded-md bg-blue-600 px-3 py-1 text-white text-xs font-medium hover:bg-blue-700 disabled:opacity-50"
        >
          {syncing ? '同步中...' : '立即同步'}
        </button>
      </div>
      {hasNew && (
        <div className="mt-1.5 text-blue-600">
          新增:{' '}
          {staleness.newSkills.map((n) => (
            <code key={n} className="mx-0.5 bg-blue-100 px-1 rounded">
              {n}
            </code>
          ))}
        </div>
      )}
    </div>
  );
}

function ConflictCard({
  conflict,
  onResolve,
  resolving,
}: {
  conflict: SkillConflict;
  onResolve: (choice: 'official' | 'mine') => void;
  resolving: boolean;
}) {
  return (
    <div className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-xs">
      <div className="flex items-center justify-between">
        <div className="text-amber-800">
          <code className="font-mono font-semibold bg-amber-100 px-1 rounded">{conflict.skillName}</code>
          <span className="ml-1.5">在用户级和项目级来源不同</span>
        </div>
        <div className="flex gap-2">
          <button
            type="button"
            onClick={() => onResolve('official')}
            disabled={resolving}
            className="rounded-md bg-blue-600 px-2.5 py-1 text-white text-xs font-medium hover:bg-blue-700 disabled:opacity-50"
          >
            用官方版本
          </button>
          <button
            type="button"
            onClick={() => onResolve('mine')}
            disabled={resolving}
            className="rounded-md bg-cafe-muted/20 px-2.5 py-1 text-cafe-primary text-xs font-medium hover:bg-cafe-muted/30 disabled:opacity-50"
          >
            用我的版本
          </button>
        </div>
      </div>
    </div>
  );
}

export function HubSkillsTab() {
  const [data, setData] = useState<SkillsData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [syncing, setSyncing] = useState(false);
  const [resolving, setResolving] = useState<string | null>(null);
  const addToast = useToastStore((s) => s.addToast);

  const fetchSkills = useCallback(async () => {
    setError(null);
    try {
      const res = await apiFetch('/api/skills');
      if (!res.ok) {
        setError('Skills 数据加载失败');
        return;
      }
      setData((await res.json()) as SkillsData);
    } catch {
      setError('网络错误');
    }
  }, []);

  const handleSync = useCallback(async () => {
    setSyncing(true);
    try {
      const res = await apiFetch('/api/skills/sync', { method: 'POST' });
      if (res.ok) {
        addToast({ type: 'success', title: '同步完成', message: 'Skills 已更新到最新版本', duration: 3000 });
        await fetchSkills();
      } else {
        addToast({ type: 'error', title: '同步失败', message: '请稍后重试', duration: 5000 });
      }
    } catch {
      addToast({ type: 'error', title: '同步失败', message: '网络错误', duration: 5000 });
    } finally {
      setSyncing(false);
    }
  }, [addToast, fetchSkills]);

  const handleResolveConflict = useCallback(
    async (skillName: string, choice: 'official' | 'mine') => {
      setResolving(skillName);
      try {
        const res = await apiFetch('/api/skills/resolve-conflict', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ skillName, choice }),
        });
        if (res.ok) {
          const label = choice === 'official' ? '官方版本' : '我的版本';
          addToast({ type: 'success', title: '冲突已解决', message: `${skillName} 使用${label}`, duration: 3000 });
          await fetchSkills();
        } else {
          addToast({ type: 'error', title: '解决失败', message: '请稍后重试', duration: 5000 });
        }
      } catch {
        addToast({ type: 'error', title: '解决失败', message: '网络错误', duration: 5000 });
      } finally {
        setResolving(null);
      }
    },
    [addToast, fetchSkills],
  );

  useEffect(() => {
    fetchSkills();
  }, [fetchSkills]);

  if (error) {
    return <p className="text-sm text-red-500 bg-red-50 rounded-lg px-3 py-2">{error}</p>;
  }
  if (!data) {
    return <p className="text-sm text-cafe-muted">加载中...</p>;
  }

  // Group skills by category, preserving BOOTSTRAP order
  const categoryOrder: string[] = [];
  const grouped = new Map<string, SkillEntry[]>();
  for (const skill of data.skills) {
    const cat = skill.category;
    if (!grouped.has(cat)) {
      categoryOrder.push(cat);
      grouped.set(cat, []);
    }
    grouped.get(cat)?.push(skill);
  }

  return (
    <>
      {data.staleness?.stale && <StaleBanner staleness={data.staleness} onSync={handleSync} syncing={syncing} />}

      {(data.conflicts?.length ?? 0) > 0 &&
        data.conflicts.map((c) => (
          <ConflictCard
            key={c.skillName}
            conflict={c}
            onResolve={(choice) => handleResolveConflict(c.skillName, choice)}
            resolving={resolving === c.skillName}
          />
        ))}

      {categoryOrder.map((cat) => (
        <CategoryGroup key={cat} category={cat} skills={grouped.get(cat)!} />
      ))}

      <div className="rounded-lg border border-cafe bg-cafe-surface-elevated/70 p-3">
        <div className="flex items-center gap-4 text-xs">
          <span className="font-semibold text-cafe-secondary">{data.summary.total} skills</span>
          <span className={data.summary.allMounted ? 'text-green-600' : 'text-amber-600'}>
            {data.summary.allMounted ? '全部正确挂载' : '部分挂载缺失'}
          </span>
          <span className={data.summary.registrationConsistent ? 'text-green-600' : 'text-amber-600'}>
            {data.summary.registrationConsistent ? '注册一致' : '注册不一致'}
          </span>
        </div>
      </div>
    </>
  );
}
