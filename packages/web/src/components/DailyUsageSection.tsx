'use client';

import { useCallback, useEffect, useState } from 'react';
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
  const [error, setError] = useState<string | null>(null);

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

  return (
    <section className="rounded-xl border border-gray-200 bg-white p-4 space-y-3">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-semibold text-gray-800">近 7 日猫粮消耗</h3>
        <button
          type="button"
          onClick={() => fetchUsage(true)}
          disabled={loading}
          className="px-3 py-1 text-xs rounded-md bg-gray-800 text-white hover:bg-gray-700 disabled:opacity-50"
        >
          {loading ? '加载中...' : '刷新'}
        </button>
      </div>

      {error && <div className="text-xs text-red-500 bg-red-50 rounded px-2 py-1">{error}</div>}

      {!error && days.length === 0 && !loading && <div className="text-xs text-gray-400 py-2">暂无消耗记录</div>}

      {days.map((day) => {
        const cats = Object.entries(day.cats).sort(
          (a, b) => b[1].inputTokens + b[1].outputTokens - (a[1].inputTokens + a[1].outputTokens),
        );
        return (
          <div key={day.date} className="border-t border-gray-100 pt-2 space-y-1">
            <div className="flex items-center justify-between text-xs">
              <span className="font-semibold text-gray-600">{day.date}</span>
              <span className="text-gray-400">{day.total.invocations} 次调用</span>
            </div>
            {cats.map(([catId, usage]) => (
              <CatUsageRow key={catId} catId={catId} usage={usage} />
            ))}
          </div>
        );
      })}

      {grandTotal && grandTotal.invocations > 0 && (
        <div className="border-t-2 border-gray-200 pt-2 flex items-center justify-between text-xs text-gray-500">
          <span className="font-semibold text-gray-700">7 日合计 {grandTotal.invocations} 次</span>
          <span className="flex gap-3">
            <span className="font-semibold text-gray-700">
              总 {formatTokens(grandTotal.inputTokens + grandTotal.outputTokens)}
            </span>
            <span>入 {formatTokens(grandTotal.inputTokens)}</span>
            <span>出 {formatTokens(grandTotal.outputTokens)}</span>
            {grandTotal.costUsd > 0 && (
              <span className="text-amber-600 font-semibold">${grandTotal.costUsd.toFixed(2)}</span>
            )}
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
        <span className="text-gray-400">{usage.participations}次</span>
      </div>
      <div className="flex items-center gap-3 text-gray-500 shrink-0">
        <span title="输入 tokens">入 {formatTokens(usage.inputTokens)}</span>
        <span title="输出 tokens">出 {formatTokens(usage.outputTokens)}</span>
      </div>
    </div>
  );
}
