'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { apiFetch } from '@/utils/api-client';

interface SkillEntry {
  name: string;
  category: string;
  trigger: string;
}

interface SkillsResponse {
  skills: SkillEntry[];
}

export function SkillPreviewPanel() {
  const [skills, setSkills] = useState<SkillEntry[]>([]);
  const [selectedSkill, setSelectedSkill] = useState<string | null>(null);
  const [content, setContent] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await apiFetch('/api/skills');
        if (cancelled) return;
        if (!res.ok) return;
        const data = (await res.json()) as SkillsResponse;
        setSkills(data.skills);
      } catch {
        /* skills list unavailable */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const latestRequestRef = useRef(0);

  const loadContent = useCallback(async (name: string) => {
    const requestId = ++latestRequestRef.current;
    setSelectedSkill(name);
    setContent(null);
    setError(null);
    setLoading(true);
    try {
      const res = await apiFetch(`/api/rules/skill/${encodeURIComponent(name)}`);
      if (requestId !== latestRequestRef.current) return;
      if (!res.ok) {
        setError(res.status === 404 ? 'SKILL.md 不存在' : '加载失败');
        return;
      }
      const data = (await res.json()) as { content: string };
      if (requestId !== latestRequestRef.current) return;
      setContent(data.content);
    } catch {
      if (requestId !== latestRequestRef.current) return;
      setError('网络错误');
    } finally {
      if (requestId === latestRequestRef.current) setLoading(false);
    }
  }, []);

  if (skills.length === 0) return null;

  return (
    <section className="console-section-shell rounded-xl p-5 md:p-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="space-y-1.5">
          <p className="text-[11px] font-semibold uppercase tracking-[0.22em] text-cafe-muted">Skills</p>
          <h3 className="text-lg font-semibold tracking-[-0.03em] text-cafe">Skill 内容预览</h3>
          <p className="text-sm leading-6 text-cafe-secondary">
            查看各 Skill 的定义文件（SKILL.md），快速核对触发方式和边界。
          </p>
        </div>
        <span className="console-pill inline-flex items-center rounded-full px-3 py-1 text-[11px] font-semibold text-cafe-secondary">
          {skills.length} skills
        </span>
      </div>
      <div className="mt-4 flex flex-wrap gap-2">
        {skills.map((skill) => (
          <button
            key={skill.name}
            onClick={() => loadContent(skill.name)}
            className={`rounded-full px-3 py-1.5 text-xs font-medium transition-colors ${
              selectedSkill === skill.name
                ? 'border border-[rgba(99,102,241,0.18)] bg-[rgba(99,102,241,0.12)] text-conn-sky-text'
                : 'console-pill text-cafe-secondary hover:text-cafe'
            }`}
          >
            {skill.name}
          </button>
        ))}
      </div>
      {selectedSkill && (
        <div className="console-table-shell mt-4 rounded-xl overflow-hidden">
          <div className="flex items-center justify-between gap-3 px-4 py-3">
            <p className="text-sm font-medium text-cafe-black">
              {selectedSkill}
              <span className="text-cafe-muted font-normal"> / SKILL.md</span>
            </p>
            <span className="console-status-chip" data-status={loading ? 'info' : error ? 'error' : 'active'}>
              {loading ? '加载中' : error ? '错误' : '已就绪'}
            </span>
          </div>
          <div className="console-code-pane">
            {loading && <p className="p-4 text-xs text-cafe-muted">加载中...</p>}
            {error && <p className="p-4 text-xs text-conn-red-text">{error}</p>}
            {content && (
              <pre className="max-h-[26rem] overflow-x-auto overflow-y-auto px-4 py-4 text-[12px] leading-6 text-cafe-secondary whitespace-pre-wrap">
                {content}
              </pre>
            )}
          </div>
        </div>
      )}
    </section>
  );
}
