'use client';

import React, { useCallback, useEffect, useState } from 'react';
import { apiFetch } from '@/utils/api-client';

interface CatDailyUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  costUsd: number;
  invocations: number;
}

interface DailyUsageEntry {
  date: string;
  cats: Record<string, CatDailyUsage>;
  total: CatDailyUsage;
}

interface DailyUsageReport {
  period: { from: string; to: string };
  daily: DailyUsageEntry[];
  grandTotal: CatDailyUsage;
}

const CAT_LABELS: Record<string, string> = {
  opus: '布偶猫 Opus',
  sonnet: '布偶猫 Sonnet',
  'opus-45': '布偶猫 Opus 4.5',
  codex: '缅因猫 Codex',
  gpt52: '缅因猫 GPT-5.4',
  spark: '缅因猫 Spark',
  gemini: '暹罗猫 Gemini',
  gemini25: '暹罗猫 Gemini 2.5',
  dare: '狸花猫',
  antigravity: '孟加拉猫',
  'antig-opus': '孟加拉猫 Opus',
  opencode: '金渐层',
};

function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(n);
}

function catLabel(catId: string): string {
  return CAT_LABELS[catId] ?? catId;
}

export function DailyUsageSection() {
  const [report, setReport] = useState<DailyUsageReport | null>(null);
  const [loading, setLoading] = useState(false);

  const fetchUsage = useCallback(async () => {
    setLoading(true);
    try {
      const res = await apiFetch('/api/usage/daily?days=1');
      if (res.ok) setReport((await res.json()) as DailyUsageReport);
    } catch {
      /* silent */
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchUsage();
  }, [fetchUsage]);

  const today = report?.daily[0] ?? null;
  const cats = today
    ? Object.entries(today.cats).sort(
        (a, b) => b[1].inputTokens + b[1].outputTokens - (a[1].inputTokens + a[1].outputTokens),
      )
    : [];
  const total = today?.total ?? report?.grandTotal;

  return (
    <section className="rounded-xl border border-gray-200 bg-white p-4 space-y-3">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-semibold text-gray-800">今日猫粮消耗</h3>
        <button
          type="button"
          onClick={fetchUsage}
          disabled={loading}
          className="px-3 py-1 text-xs rounded-md bg-gray-800 text-white hover:bg-gray-700 disabled:opacity-50"
        >
          {loading ? '加载中...' : '刷新'}
        </button>
      </div>

      {!today && !loading && <div className="text-xs text-gray-400 py-2">今日暂无消耗记录</div>}

      {cats.length > 0 && (
        <div className="space-y-2">
          {cats.map(([catId, usage]) => (
            <CatUsageRow key={catId} catId={catId} usage={usage} />
          ))}
        </div>
      )}

      {total && total.invocations > 0 && (
        <div className="border-t border-gray-100 pt-2 flex items-center justify-between text-xs text-gray-500">
          <span>合计 {total.invocations} 次调用</span>
          <span className="flex gap-3">
            <span>入 {formatTokens(total.inputTokens)}</span>
            <span>出 {formatTokens(total.outputTokens)}</span>
            {total.costUsd > 0 && <span className="text-amber-600">${total.costUsd.toFixed(2)}</span>}
          </span>
        </div>
      )}
    </section>
  );
}

function CatUsageRow({ catId, usage }: { catId: string; usage: CatDailyUsage }) {
  return (
    <div className="flex items-center justify-between gap-2 text-xs">
      <div className="flex items-center gap-2 min-w-0">
        <span className="font-medium text-gray-700 truncate">{catLabel(catId)}</span>
        <span className="text-gray-400">{usage.invocations}次</span>
      </div>
      <div className="flex items-center gap-3 text-gray-500 shrink-0">
        <span title="输入 tokens">入 {formatTokens(usage.inputTokens)}</span>
        <span title="输出 tokens">出 {formatTokens(usage.outputTokens)}</span>
      </div>
    </div>
  );
}
