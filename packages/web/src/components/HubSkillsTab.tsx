'use client';

import { useCallback, useEffect, useState } from 'react';
import { apiFetch } from '@/utils/api-client';

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

interface SkillsData {
  skills: SkillEntry[];
  summary: SkillsSummary;
}

function MountBadge({ mounted }: { mounted: boolean }) {
  return mounted ? (
    <span className="inline-flex items-center justify-center w-5 h-5 rounded-full bg-green-100 text-green-600 text-xs font-bold">
      ✓
    </span>
  ) : (
    <span className="inline-flex items-center justify-center w-5 h-5 rounded-full bg-red-100 text-red-500 text-xs font-bold">
      ✗
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

export function HubSkillsTab() {
  const [data, setData] = useState<SkillsData | null>(null);
  const [error, setError] = useState<string | null>(null);

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
