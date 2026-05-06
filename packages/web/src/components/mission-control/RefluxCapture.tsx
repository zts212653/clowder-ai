'use client';

import type { RefluxCategory, RefluxPattern } from '@cat-cafe/shared';
import { useCallback, useState } from 'react';
import { apiFetch } from '@/utils/api-client';

const CATEGORY_STYLES: Record<RefluxCategory, { bg: string; text: string; label: string }> = {
  methodology: { bg: 'bg-[var(--color-cafe-accent)]/10', text: 'text-[var(--color-cafe-accent)]', label: '方法论' },
  risk_pattern: { bg: 'bg-conn-amber-bg', text: 'text-conn-amber-text', label: '风险模式' },
  resolution_strategy: { bg: 'bg-conn-emerald-bg', text: 'text-conn-emerald-text', label: '解决策略' },
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
          <div className="text-sm font-semibold text-cafe">经验回流</div>
          <div className="text-[10px] text-cafe-muted">方法论经验沉淀 — 只回流知识，不回流项目数据</div>
        </div>
        <button
          type="button"
          onClick={() => setShowForm(!showForm)}
          className="rounded-lg bg-[var(--cafe-accent)] px-3 py-1.5 text-xs font-medium text-[var(--cafe-surface)] hover:bg-[var(--cafe-accent-hover,#7A6139)]"
        >
          {showForm ? '取消' : 'Capture Insight'}
        </button>
      </div>

      {/* Capture form */}
      {showForm && (
        <div className="space-y-2 rounded-lg bg-[var(--console-card-bg)] shadow-[0_12px_30px_rgba(43,33,26,0.08)] p-4">
          <select
            value={category}
            onChange={(e) => setCategory(e.target.value as RefluxCategory)}
            className="console-form-input"
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
            className="console-form-input"
          />
          <textarea
            value={insight}
            onChange={(e) => setInsight(e.target.value)}
            placeholder="Insight..."
            rows={3}
            className="console-form-input"
          />
          <textarea
            value={evidence}
            onChange={(e) => setEvidence(e.target.value)}
            placeholder="Evidence..."
            rows={2}
            className="console-form-input"
          />
          <button
            type="button"
            onClick={() => void handleCreate()}
            disabled={submitting || !title.trim() || !insight.trim()}
            className="w-full rounded-lg bg-[var(--cafe-accent)] py-1.5 text-xs font-medium text-[var(--cafe-surface)] hover:bg-[var(--cafe-accent-hover,#7A6139)] disabled:opacity-40"
          >
            {submitting ? '提交中...' : '提交'}
          </button>
        </div>
      )}

      {/* Pattern list */}
      {patterns.length === 0 ? (
        <div className="rounded-lg border border-dashed border-[var(--console-border-soft)] bg-[var(--console-card-bg)] p-6 text-center text-xs text-cafe-muted">
          暂无经验记录
        </div>
      ) : (
        <div className="space-y-2">
          {patterns.map((p) => {
            const style = CATEGORY_STYLES[p.category];
            return (
              <div key={p.id} className="rounded-lg bg-[var(--console-field-bg)] p-3 text-xs">
                <div className="mb-1 flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <span className={`rounded-full px-2 py-0.5 text-[10px] font-medium ${style.bg} ${style.text}`}>
                      {style.label}
                    </span>
                    <span className="font-medium text-cafe">{p.title}</span>
                  </div>
                  <button
                    type="button"
                    onClick={() => void handleDelete(p.id)}
                    className="text-[10px] text-conn-red-text hover:opacity-80"
                  >
                    删除
                  </button>
                </div>
                <div className="text-cafe-secondary">{p.insight}</div>
                {p.evidence && (
                  <div className="mt-1 rounded bg-[var(--console-pill-bg)] px-2 py-1 text-[10px] text-cafe-muted">
                    {p.evidence}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
