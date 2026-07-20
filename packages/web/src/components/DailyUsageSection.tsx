'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { type CatData, useCatData } from '@/hooks/useCatData';
import { formatCatDisplayName } from '@/lib/cat-display-name';
import { apiFetch } from '@/utils/api-client';

interface CatDailyUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  costUsd: number;
  participations: number;
}

interface UsageTotals {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  costUsd: number;
  invocations: number;
}

interface DailyUsageEntry {
  date: string;
  cats: Record<string, CatDailyUsage>;
  total: UsageTotals;
}

interface DailyUsageReport {
  period: { from: string; to: string };
  daily: DailyUsageEntry[];
  grandTotal: UsageTotals;
}

function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(n);
}

/**
 * Issue #845: derive label from runtime catRegistry (via useCatData) instead of a
 * hardcoded table. Uses the same "displayName（variantLabel）" contract as chat,
 * then falls back to raw catId. Avoids the previous drift where
 * `gpt52` was labeled "GPT-5.4" but actually ran `gpt-5.5`.
 */
export function buildCatLabel(catId: string, cat: CatData | undefined): string {
  if (!cat) return catId;
  return formatCatDisplayName(cat);
}

export function DailyUsageSection() {
  const { cats: catRegistry } = useCatData();
  const [report, setReport] = useState<DailyUsageReport | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const catById = useMemo(() => {
    const map = new Map<string, CatData>();
    for (const cat of catRegistry) map.set(cat.id, cat);
    return map;
  }, [catRegistry]);

  const fetchUsage = useCallback(async (refresh = false) => {
    setLoading(true);
    setError(null);
    try {
      const url = refresh ? '/api/usage/daily?days=7&refresh=1' : '/api/usage/daily?days=7';
      const res = await apiFetch(url);
      if (res.ok) {
        setReport((await res.json()) as DailyUsageReport);
      } else {
        setError(`获取失败 (${res.status})`);
      }
    } catch {
      setError('无法连接到服务器');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchUsage();
  }, [fetchUsage]);

  const days = report?.daily ?? [];
  const grandTotal = report?.grandTotal;

  // Issue #845: clarify "次调用" vs sum of per-cat participations.
  // Multi-cat invocations count once toward day.total.invocations, but each
  // cat participation increments its own count — so per-cat counts can sum
  // to more than the day total. Show the math in a tooltip rather than hiding it.
  const invocationCountTitle =
    '次调用 = 当日 invocation 记录数；下方每只猫的次数是各自参与次数。多猫调用让各猫之和 ≥ 总次数。';

  return (
    <section className="console-list-card rounded-xl shadow-[0_8px_22px_rgba(43,33,26,0.04)] p-4 space-y-3">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-semibold text-cafe">近 7 日猫粮消耗</h3>
        <button
          type="button"
          onClick={() => fetchUsage(true)}
          disabled={loading}
          className="rounded-lg bg-cafe-accent px-3 py-1.5 text-xs font-semibold text-[var(--cafe-surface)] transition-colors hover:bg-cafe-accent-hover disabled:opacity-50"
        >
          {loading ? '加载中...' : '刷新'}
        </button>
      </div>

      {error && <div className="text-xs text-conn-red-text bg-conn-red-bg rounded px-2 py-1">{error}</div>}

      {!error && days.length === 0 && !loading && <div className="text-xs text-cafe-muted py-2">暂无消耗记录</div>}

      {days.map((day) => {
        const cats = Object.entries(day.cats).sort(
          (a, b) => b[1].inputTokens + b[1].outputTokens - (a[1].inputTokens + a[1].outputTokens),
        );
        return (
          <div key={day.date} className="border-t border-cafe-subtle pt-2 space-y-1">
            <div className="flex items-center justify-between text-xs">
              <span className="font-semibold text-cafe-secondary">{day.date}</span>
              <span className="text-cafe-muted cursor-help" title={invocationCountTitle}>
                {day.total.invocations} 次调用
              </span>
            </div>
            {cats.map(([catId, usage]) => (
              <CatUsageRow key={catId} catId={catId} usage={usage} cat={catById.get(catId)} />
            ))}
          </div>
        );
      })}

      {grandTotal && grandTotal.invocations > 0 && (
        <div className="border-t-2 border-cafe pt-2 flex items-center justify-between text-xs text-cafe-secondary">
          <span className="font-semibold text-cafe-secondary cursor-help" title={invocationCountTitle}>
            7 日合计 {grandTotal.invocations} 次
          </span>
          <span className="flex gap-3">
            <span className="font-semibold text-cafe-secondary">
              总 {formatTokens(grandTotal.inputTokens + grandTotal.outputTokens)}
            </span>
            <span>入 {formatTokens(grandTotal.inputTokens)}</span>
            <span>出 {formatTokens(grandTotal.outputTokens)}</span>
            {grandTotal.costUsd > 0 && (
              <span className="text-conn-amber-text font-semibold">${grandTotal.costUsd.toFixed(2)}</span>
            )}
          </span>
        </div>
      )}
    </section>
  );
}

function CatUsageRow({ catId, usage, cat }: { catId: string; usage: CatDailyUsage; cat: CatData | undefined }) {
  const label = buildCatLabel(catId, cat);
  const technicalLabel = label === catId ? catId : `${label} · ${catId}`;
  // Issue #845 (砚砚 P2 fix): show the catId's *current* defaultModel as a hint,
  // NOT as a historical attribution. The aggregated TokenUsage has no per-record
  // model field — a single catId may have run multiple model versions over time.
  // The "当前默认" prefix + tooltip keep the semantics explicit so the user never
  // mistakes the inline label for a per-day model. A follow-up issue tracks the
  // proper (catId, model) double-key schema.
  const model = cat?.defaultModel;
  return (
    <div className="flex items-center justify-between gap-2 text-xs">
      <div className="flex items-center gap-2 min-w-0">
        <span className="font-medium text-cafe-secondary truncate">{label}</span>
        {model && (
          <span
            className="text-cafe-muted text-micro truncate italic"
            title={`${technicalLabel} 当前默认模型：${model}。历史聚合按 catId 分桶，不区分模型版本。`}
          >
            当前默认 {model}
          </span>
        )}
        <span className="text-cafe-muted">{usage.participations}次</span>
      </div>
      <div className="flex items-center gap-3 text-cafe-secondary shrink-0">
        <span title="输入 tokens">入 {formatTokens(usage.inputTokens)}</span>
        <span title="输出 tokens">出 {formatTokens(usage.outputTokens)}</span>
      </div>
    </div>
  );
}
