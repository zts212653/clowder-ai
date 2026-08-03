'use client';

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import type { Thread, ThreadRoutingPolicyV1 } from '@/stores/chat-types';
import { useChatStore } from '@/stores/chatStore';
import { apiFetch } from '@/utils/api-client';
import { DailyUsageSection } from './DailyUsageSection';
import { HubQuotaBoardTab } from './HubQuotaBoardTab';

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="console-list-card rounded-xl p-4 shadow-[0_8px_22px_rgba(43,33,26,0.04)]">
      <h3 className="text-xs font-semibold text-cafe-secondary mb-2">{title}</h3>
      {children}
    </section>
  );
}

interface RoutingCat {
  id: string;
  mentionPatterns?: string[];
  roster: {
    available: boolean;
    successor?: string;
  } | null;
}

export function resolveRoutingTarget(cats: RoutingCat[], legacyCatId: string): { id: string; mention: string } | null {
  const legacy = cats.find((cat) => cat.id === legacyCatId);
  const targetId = legacy?.roster?.available !== false ? legacyCatId : legacy.roster.successor;
  const target = targetId ? cats.find((cat) => cat.id === targetId && cat.roster?.available !== false) : undefined;
  if (!target) return null;

  const canonical = `@${target.id}`;
  const mention = target.mentionPatterns?.find((pattern) => pattern.toLowerCase() === canonical.toLowerCase());
  return { id: target.id, mention: mention ?? canonical };
}

export function buildPolicy(params: {
  reviewAvoidOpus: boolean;
  architecturePreferOpus: boolean;
  routingCatId: string;
}): ThreadRoutingPolicyV1 | null {
  const scopes: NonNullable<ThreadRoutingPolicyV1['scopes']> = {};
  if (params.reviewAvoidOpus) {
    scopes.review = { avoidCats: [params.routingCatId], reason: 'budget' };
  }
  if (params.architecturePreferOpus) {
    scopes.architecture = { preferCats: [params.routingCatId] };
  }
  return Object.keys(scopes).length > 0 ? { v: 1, scopes } : null;
}

export function HubRoutingPolicyTab() {
  const threadId = useChatStore((s) => s.currentThreadId);
  const [thread, setThread] = useState<Thread | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [savedAt, setSavedAt] = useState<number | null>(null);
  const [routingTarget, setRoutingTarget] = useState<{ id: string; mention: string } | null>(null);

  const [reviewAvoidOpus, setReviewAvoidOpus] = useState(false);
  const [architecturePreferOpus, setArchitecturePreferOpus] = useState(false);

  const currentPolicy = useMemo(() => {
    const p = thread?.routingPolicy;
    if (!p || p.v !== 1) return null;
    return p;
  }, [thread]);

  const fetchThread = useCallback(async () => {
    setError(null);
    setRoutingTarget(null);
    try {
      const [threadRes, catsRes] = await Promise.all([
        apiFetch(`/api/threads/${encodeURIComponent(threadId)}`),
        apiFetch('/api/cats'),
      ]);
      if (!threadRes.ok || !catsRes.ok) {
        setError('线程信息加载失败');
        return;
      }
      const t = (await threadRes.json()) as Thread;
      const catsBody = (await catsRes.json()) as { cats?: RoutingCat[] };
      const target = resolveRoutingTarget(catsBody.cats ?? [], 'opus');
      setThread(t);
      setRoutingTarget(target);
      if (!target) setError('未找到可用的架构猫替代者');

      const policy = t.routingPolicy;
      const avoid = policy?.scopes?.review?.avoidCats ?? [];
      const prefer = policy?.scopes?.architecture?.preferCats ?? [];
      const recognizedIds = target ? ['opus', target.id] : ['opus'];
      setReviewAvoidOpus(recognizedIds.some((id) => avoid.includes(id)));
      setArchitecturePreferOpus(recognizedIds.some((id) => prefer.includes(id)));
    } catch {
      setError('网络错误');
    }
  }, [threadId]);

  useEffect(() => {
    fetchThread();
  }, [fetchThread]);

  const onSave = useCallback(async () => {
    if (!routingTarget) return;
    setSaving(true);
    setError(null);
    try {
      const routingPolicy = buildPolicy({
        reviewAvoidOpus,
        architecturePreferOpus,
        routingCatId: routingTarget.id,
      });
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
  }, [threadId, reviewAvoidOpus, architecturePreferOpus, routingTarget]);

  const routingMention = routingTarget?.mention ?? '不可用';

  return (
    <div className="space-y-4">
      <HubQuotaBoardTab />

      <Section title="路由策略（猫粮约束子模块）">
        <p className="text-xs text-cafe-secondary mb-3">
          默认是猫猫自治路由；这里只放你明确要求的硬约束（比如预算/猫粮）。显式 @ 指名永远优先。
        </p>

        {error && <p className="text-sm text-conn-red-text bg-conn-red-bg rounded-lg px-3 py-2 mb-3">{error}</p>}

        <div className="space-y-3">
          <div className="flex items-start justify-between gap-3">
            <div>
              <div className="text-sm font-medium text-cafe">审查范围</div>
              <div className="text-xs text-cafe-secondary">当消息明显是 review/合入/PR 场景时生效</div>
            </div>
            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={reviewAvoidOpus}
                disabled={!routingTarget}
                onChange={(e) => setReviewAvoidOpus(e.target.checked)}
              />
              避开 {routingMention}（budget）
            </label>
          </div>

          <div className="flex items-start justify-between gap-3">
            <div>
              <div className="text-sm font-medium text-cafe">架构范围</div>
              <div className="text-xs text-cafe-secondary">当消息明显是 架构/设计/tradeoff 场景时生效</div>
            </div>
            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={architecturePreferOpus}
                disabled={!routingTarget}
                onChange={(e) => setArchitecturePreferOpus(e.target.checked)}
              />
              优先 {routingMention}
            </label>
          </div>

          <div className="flex items-center justify-between gap-3 pt-2">
            <div className="text-xs text-cafe-secondary">
              {currentPolicy ? '当前已启用策略' : '当前未启用策略'}
              {savedAt ? ` · 已保存 ${new Date(savedAt).toLocaleTimeString()}` : ''}
            </div>
            <button
              type="button"
              onClick={onSave}
              disabled={saving || !routingTarget}
              className="px-3 py-2 text-sm rounded-lg bg-cafe-accent text-[var(--cafe-surface)] hover:bg-cafe-interactive disabled:opacity-60"
            >
              {saving ? '保存中...' : '保存'}
            </button>
          </div>
        </div>
      </Section>

      <DailyUsageSection />
    </div>
  );
}
