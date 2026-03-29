'use client';

import type { RefluxCategory, RefluxPattern } from '@cat-cafe/shared';
import { useCallback, useState } from 'react';
import { apiFetch } from '@/utils/api-client';

const CATEGORY_STYLES: Record<RefluxCategory, { bg: string; text: string; label: string }> = {
  methodology: { bg: 'bg-blue-100', text: 'text-blue-800', label: '方法论' },
  risk_pattern: { bg: 'bg-orange-100', text: 'text-orange-800', label: '风险模式' },
  resolution_strategy: { bg: 'bg-green-100', text: 'text-green-800', label: '解决策略' },
};

const CATEGORY_OPTIONS: RefluxCategory[] = ['methodology', 'risk_pattern', 'resolution_strategy'];

interface RefluxCaptureProps {
  projectId: string;
  patterns: RefluxPattern[];
  onUpdate: () => void;
}

export function RefluxCapture({ projectId, patterns, onUpdate }: RefluxCaptureProps) {
  const [showForm, setShowForm] = useState(false);
  const [category, setCategory] = useState<RefluxCategory>('methodology');
  const [title, setTitle] = useState('');
  const [insight, setInsight] = useState('');
  const [evidence, setEvidence] = useState('');
  const [submitting, setSubmitting] = useState(false);

  const handleCreate = useCallback(async () => {
    if (!title.trim() || !insight.trim()) return;
    setSubmitting(true);
    try {
      const res = await apiFetch(`/api/external-projects/${projectId}/reflux-patterns`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ category, title, insight, evidence }),
      });
      if (res.ok) {
        setShowForm(false);
        setTitle('');
        setInsight('');
        setEvidence('');
        onUpdate();
      }
    } finally {
      setSubmitting(false);
    }
  }, [projectId, category, title, insight, evidence, onUpdate]);

  const handleDelete = useCallback(
    async (id: string) => {
      const res = await apiFetch(`/api/external-projects/${projectId}/reflux-patterns/${id}`, {
        method: 'DELETE',
      });
      if (res.ok || res.status === 204) onUpdate();
    },
    [projectId, onUpdate],
  );

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <div className="text-sm font-semibold text-[#2B2118]">经验回流</div>
          <div className="text-[10px] text-[#9A866F]">方法论经验沉淀 — 只回流知识，不回流项目数据</div>
        </div>
        <button
          type="button"
          onClick={() => setShowForm(!showForm)}
          className="rounded-lg bg-[#8B6F47] px-3 py-1.5 text-xs font-medium text-white hover:bg-[#7A6139]"
        >
          {showForm ? '取消' : 'Capture Insight'}
        </button>
      </div>

      {/* Capture form */}
      {showForm && (
        <div className="space-y-2 rounded-lg border border-[#E7DAC7] bg-[#FFFDF8] p-4">
          <select
            value={category}
            onChange={(e) => setCategory(e.target.value as RefluxCategory)}
            className="w-full rounded border border-[#E7DAC7] bg-cafe-surface px-2 py-1.5 text-xs text-[#2B2118]"
          >
            {CATEGORY_OPTIONS.map((c) => (
              <option key={c} value={c}>
                {CATEGORY_STYLES[c].label}
              </option>
            ))}
          </select>
          <input
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="标题"
            className="w-full rounded border border-[#E7DAC7] bg-cafe-surface px-2 py-1.5 text-xs text-[#2B2118]"
          />
          <textarea
            value={insight}
            onChange={(e) => setInsight(e.target.value)}
            placeholder="Insight..."
            rows={3}
            className="w-full rounded border border-[#E7DAC7] bg-cafe-surface px-2 py-1.5 text-xs text-[#2B2118]"
          />
          <textarea
            value={evidence}
            onChange={(e) => setEvidence(e.target.value)}
            placeholder="Evidence..."
            rows={2}
            className="w-full rounded border border-[#E7DAC7] bg-cafe-surface px-2 py-1.5 text-xs text-[#2B2118]"
          />
          <button
            type="button"
            onClick={() => void handleCreate()}
            disabled={submitting || !title.trim() || !insight.trim()}
            className="w-full rounded-lg bg-[#8B6F47] py-1.5 text-xs font-medium text-white hover:bg-[#7A6139] disabled:opacity-40"
          >
            {submitting ? '提交中...' : '提交'}
          </button>
        </div>
      )}

      {/* Pattern list */}
      {patterns.length === 0 ? (
        <div className="rounded-lg border border-dashed border-[#D8C6AD] bg-[#FBF7F0] p-6 text-center text-xs text-[#9A866F]">
          暂无经验记录
        </div>
      ) : (
        <div className="space-y-2">
          {patterns.map((p) => {
            const style = CATEGORY_STYLES[p.category];
            return (
              <div key={p.id} className="rounded-lg border border-[#E7DAC7] bg-[#FFFDF8] p-3 text-xs">
                <div className="mb-1 flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <span className={`rounded-full px-2 py-0.5 text-[10px] font-medium ${style.bg} ${style.text}`}>
                      {style.label}
                    </span>
                    <span className="font-medium text-[#2B2118]">{p.title}</span>
                  </div>
                  <button
                    type="button"
                    onClick={() => void handleDelete(p.id)}
                    className="text-[10px] text-red-500 hover:text-red-700"
                  >
                    删除
                  </button>
                </div>
                <div className="text-[#6B5D4F]">{p.insight}</div>
                {p.evidence && (
                  <div className="mt-1 rounded bg-[#F4EFE7] px-2 py-1 text-[10px] text-[#9A866F]">{p.evidence}</div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
