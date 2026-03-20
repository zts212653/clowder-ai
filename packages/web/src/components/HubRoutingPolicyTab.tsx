'use client';

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import type { Thread, ThreadRoutingPolicyV1 } from '@/stores/chat-types';
import { useChatStore } from '@/stores/chatStore';
import { apiFetch } from '@/utils/api-client';
import { HubQuotaBoardTab } from './HubQuotaBoardTab';

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="rounded-lg border border-gray-200 bg-gray-50/70 p-3">
      <h3 className="text-xs font-semibold text-gray-700 mb-2">{title}</h3>
      {children}
    </section>
  );
}

function buildPolicy(params: {
  reviewAvoidOpus: boolean;
  architecturePreferOpus: boolean;
}): ThreadRoutingPolicyV1 | null {
  const scopes: NonNullable<ThreadRoutingPolicyV1['scopes']> = {};
  if (params.reviewAvoidOpus) {
    scopes.review = { avoidCats: ['opus'], reason: 'budget' };
  }
  if (params.architecturePreferOpus) {
    scopes.architecture = { preferCats: ['opus'] };
  }
  return Object.keys(scopes).length > 0 ? { v: 1, scopes } : null;
}

export function HubRoutingPolicyTab() {
  const threadId = useChatStore((s) => s.currentThreadId);
  const [thread, setThread] = useState<Thread | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [savedAt, setSavedAt] = useState<number | null>(null);

  // UI toggles (v1: only controls Opus, but model is extensible)
  const [reviewAvoidOpus, setReviewAvoidOpus] = useState(false);
  const [architecturePreferOpus, setArchitecturePreferOpus] = useState(false);

  const currentPolicy = useMemo(() => {
    const p = thread?.routingPolicy;
    if (!p || p.v !== 1) return null;
    return p;
  }, [thread]);

  const fetchThread = useCallback(async () => {
    setError(null);
    try {
      const res = await apiFetch(`/api/threads/${encodeURIComponent(threadId)}`);
      if (!res.ok) {
        setError('线程信息加载失败');
        return;
      }
      const t = (await res.json()) as Thread;
      setThread(t);

      const policy = t.routingPolicy;
      const avoid = policy?.scopes?.review?.avoidCats ?? [];
      const prefer = policy?.scopes?.architecture?.preferCats ?? [];
      setReviewAvoidOpus(avoid.includes('opus'));
      setArchitecturePreferOpus(prefer.includes('opus'));
    } catch {
      setError('网络错误');
    }
  }, [threadId]);

  useEffect(() => {
    fetchThread();
  }, [fetchThread]);

  const onSave = useCallback(async () => {
    setSaving(true);
    setError(null);
    try {
      const routingPolicy = buildPolicy({ reviewAvoidOpus, architecturePreferOpus });
      const res = await apiFetch(`/api/threads/${encodeURIComponent(threadId)}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ routingPolicy }),
      });
      if (!res.ok) {
        setError('保存失败');
        return;
      }
      const updated = (await res.json()) as Thread;
      setThread(updated);
      setSavedAt(Date.now());
    } catch {
      setError('网络错误');
    } finally {
      setSaving(false);
    }
  }, [threadId, reviewAvoidOpus, architecturePreferOpus]);

  return (
    <div className="space-y-4">
      <HubQuotaBoardTab />

      <Section title="路由策略（猫粮约束子模块）">
        <p className="text-[11px] text-gray-500 mb-3">
          默认是猫猫自治路由；这里只放你明确要求的硬约束（比如预算/猫粮）。显式 @ 指名永远优先。
        </p>

        {error && <p className="text-sm text-red-500 bg-red-50 rounded-lg px-3 py-2 mb-3">{error}</p>}

        <div className="space-y-3">
          <div className="flex items-start justify-between gap-3">
            <div>
              <div className="text-sm font-medium text-gray-800">Review scope</div>
              <div className="text-[11px] text-gray-500">当消息明显是 review/合入/PR 场景时生效</div>
            </div>
            <label className="flex items-center gap-2 text-sm">
              <input type="checkbox" checked={reviewAvoidOpus} onChange={(e) => setReviewAvoidOpus(e.target.checked)} />
              避开 @opus（budget）
            </label>
          </div>

          <div className="flex items-start justify-between gap-3">
            <div>
              <div className="text-sm font-medium text-gray-800">Architecture scope</div>
              <div className="text-[11px] text-gray-500">当消息明显是 架构/设计/tradeoff 场景时生效</div>
            </div>
            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={architecturePreferOpus}
                onChange={(e) => setArchitecturePreferOpus(e.target.checked)}
              />
              优先 @opus
            </label>
          </div>

          <div className="flex items-center justify-between gap-3 pt-2">
            <div className="text-[11px] text-gray-500">
              {currentPolicy ? '当前已启用策略' : '当前未启用策略'}
              {savedAt ? ` · 已保存 ${new Date(savedAt).toLocaleTimeString()}` : ''}
            </div>
            <button
              onClick={onSave}
              disabled={saving}
              className="px-3 py-2 text-sm rounded-lg bg-blue-600 text-white disabled:opacity-60"
            >
              {saving ? '保存中...' : '保存'}
            </button>
          </div>
        </div>
      </Section>
    </div>
  );
}
