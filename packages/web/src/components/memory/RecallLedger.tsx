'use client';

/**
 * RecallLedger — F263 B.5 Task 4 + Phase C AC-C2
 *
 * Workspace panel "账本" sub-tab:
 * 1. Simultaneous 7/14/30 day comparison table with Pull-vs-Push funnel bars
 * 2. Three-axis lifecycle section (harmful consumption / unmet demand / attention cost)
 *    with maturity labels — no total score.
 *
 * Design: existing ledger + three-axis in same page, narrow width stacks vertically.
 */

import { useCallback, useEffect, useState } from 'react';
import { apiFetch } from '@/utils/api-client';
import { LedgerBookIcon } from './RecallLedgerIcons';
import { RECALL_WINDOWS, ThreeAxisSection, type ThreeAxisSnapshot } from './RecallLedgerThreeAxis';

interface LedgerRow {
  source: 'push' | 'pull';
  surface: string;
  presented: number;
  inspected: number;
  used: number;
}

interface LedgerResponse {
  days: number;
  from: number;
  to: number;
  rows: LedgerRow[];
}

interface WindowSummary {
  presented: number;
  inspected: number;
  used: number;
  utilRate: string;
  pullPresented: number;
  pullRate: string;
  pushPresented: number;
  pushRate: string;
  from: number;
  to: number;
}

function summarize(data: LedgerResponse | null): WindowSummary | null {
  if (!data) return null;
  const presented = data.rows.reduce((s, r) => s + r.presented, 0);
  const inspected = data.rows.reduce((s, r) => s + r.inspected, 0);
  const used = data.rows.reduce((s, r) => s + r.used, 0);
  const pullRows = data.rows.filter((r) => r.source === 'pull');
  const pushRows = data.rows.filter((r) => r.source === 'push');
  const pullPresented = pullRows.reduce((s, r) => s + r.presented, 0);
  const pullUsed = pullRows.reduce((s, r) => s + r.used, 0);
  const pushPresented = pushRows.reduce((s, r) => s + r.presented, 0);
  const pushUsed = pushRows.reduce((s, r) => s + r.used, 0);
  return {
    presented,
    inspected,
    used,
    utilRate: presented > 0 ? ((used / presented) * 100).toFixed(1) : '—',
    pullPresented,
    pullRate: pullPresented > 0 ? ((pullUsed / pullPresented) * 100).toFixed(0) : '0',
    pushPresented,
    pushRate: pushPresented > 0 ? ((pushUsed / pushPresented) * 100).toFixed(0) : '0',
    from: data.from,
    to: data.to,
  };
}

export function RecallLedger() {
  const [windows, setWindows] = useState<Record<number, LedgerResponse | null>>({});
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [threeAxis, setThreeAxis] = useState<Record<number, ThreeAxisSnapshot | null>>({});
  const [axisLoading, setAxisLoading] = useState(false);

  const fetchAll = useCallback(async () => {
    setLoading(true);
    setError(null);
    setWindows({});
    try {
      const results = await Promise.all(
        RECALL_WINDOWS.map(async (d) => {
          const res = await apiFetch(`/api/recall/ledger?days=${d}`);
          if (!res.ok) throw new Error(`${res.status}`);
          return [d, await res.json()] as [number, LedgerResponse];
        }),
      );
      setWindows(Object.fromEntries(results));
    } catch (e) {
      setError(e instanceof Error ? e.message : 'fetch failed');
    } finally {
      setLoading(false);
    }
  }, []);

  const fetchThreeAxis = useCallback(async () => {
    setAxisLoading(true);
    try {
      const results = await Promise.all(
        RECALL_WINDOWS.map(async (d) => {
          const res = await apiFetch(`/api/recall/lifecycle/three-axis?days=${d}`);
          if (!res.ok) return [d, null] as [number, null];
          return [d, await res.json()] as [number, ThreeAxisSnapshot];
        }),
      );
      setThreeAxis(Object.fromEntries(results));
    } catch {
      // Three-axis is additive — fail silently, the consumption table still works
    } finally {
      setAxisLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchAll();
    fetchThreeAxis();
  }, [fetchAll, fetchThreeAxis]);

  const summaries = RECALL_WINDOWS.map((d) => summarize(windows[d] ?? null));
  const hasData = summaries.some((s) => s !== null);
  const allEmpty = hasData && summaries.every((s) => s && s.presented === 0);
  const dateRange = summaries[2]; // 30d window for range display

  return (
    <div data-testid="recall-ledger" className="space-y-3 p-3">
      <div className="flex items-center justify-between">
        <span className="flex items-center gap-1.5 text-xs font-semibold text-cafe-black">
          <LedgerBookIcon className="h-4 w-4 text-cafe-accent" />
          消费账本
        </span>
      </div>

      {loading && (
        <div data-testid="recall-ledger-loading" className="text-xs text-cafe-secondary animate-pulse">
          加载中...
        </div>
      )}

      {error && (
        <div data-testid="recall-ledger-error" className="flex items-center gap-2 text-xs text-[var(--semantic-error)]">
          <span>加载失败: {error}</span>
          <button
            type="button"
            onClick={fetchAll}
            className="rounded px-1.5 py-0.5 text-micro font-semibold text-cafe-accent hover:bg-cafe-accent/10"
          >
            重试
          </button>
        </div>
      )}

      {hasData && !loading && !error && (
        <>
          {allEmpty ? (
            <div data-testid="recall-ledger-empty" className="text-xs text-cafe-secondary py-4 text-center">
              该时间范围还没有 recall 记录
            </div>
          ) : (
            <>
              {/* Comparison table: 7d / 14d / 30d side-by-side */}
              <div className="rounded-lg bg-[var(--console-card-bg)] overflow-hidden">
                <table className="w-full text-xs">
                  <thead>
                    <tr className="text-cafe-secondary border-b border-[var(--console-border-soft)]/40">
                      <th className="text-left px-2.5 py-1.5 font-semibold">窗口</th>
                      {RECALL_WINDOWS.map((d) => (
                        <th key={d} className="text-right px-2.5 py-1.5 font-semibold">
                          {d}天
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    <MetricRow label="投喂" values={summaries.map((s) => s?.presented)} />
                    <MetricRow label="检视" values={summaries.map((s) => s?.inspected)} />
                    <MetricRow label="使用" values={summaries.map((s) => s?.used)} tone="text-conn-green-text" />
                    <MetricRow
                      label="使用率"
                      values={summaries.map((s) => (s ? `${s.utilRate}%` : undefined))}
                      tone="text-cafe-accent"
                    />
                  </tbody>
                </table>
              </div>

              {/* Pull vs Push funnel bars — only show sources with actual data */}
              {(summaries[0]?.pullPresented ?? 0) > 0 || (summaries[0]?.pushPresented ?? 0) > 0 ? (
                <div data-testid="recall-ledger-funnels" className="space-y-1.5">
                  {(summaries[0]?.pullPresented ?? 0) > 0 && (
                    <FunnelBar label="Pull 使用率" rate={summaries[0]?.pullRate ?? '0'} color="bg-conn-blue-bg" />
                  )}
                  {(summaries[0]?.pushPresented ?? 0) > 0 && (
                    <FunnelBar label="Push 使用率" rate={summaries[0]?.pushRate ?? '0'} color="bg-conn-amber-bg" />
                  )}
                </div>
              ) : null}

              {/* Date range */}
              {dateRange && (
                <div className="text-micro text-cafe-secondary/60 text-center">
                  数据范围：{new Date(dateRange.from).toLocaleDateString('zh-CN')} —{' '}
                  {new Date(dateRange.to).toLocaleDateString('zh-CN')}
                </div>
              )}
            </>
          )}

          {/* F263 Phase C: Three-axis lifecycle section */}
          <ThreeAxisSection snapshots={threeAxis} loading={axisLoading} />
        </>
      )}
    </div>
  );
}

function MetricRow({
  label,
  values,
  tone,
}: {
  label: string;
  values: (number | string | undefined | null)[];
  tone?: string;
}) {
  return (
    <tr className="border-b border-[var(--console-border-soft)]/20 last:border-0">
      <td className="px-2.5 py-1.5 text-cafe-secondary font-medium">{label}</td>
      {values.map((v, i) => (
        <td key={RECALL_WINDOWS[i]} className={`text-right px-2.5 py-1.5 font-semibold ${tone ?? 'text-cafe-black'}`}>
          {v ?? '—'}
        </td>
      ))}
    </tr>
  );
}

function FunnelBar({ label, rate, color }: { label: string; rate: string; color: string }) {
  const pct = Math.min(100, Math.max(0, Number.parseInt(rate, 10) || 0));
  return (
    <div className="flex items-center gap-2 text-xs">
      <span className="w-20 text-cafe-secondary shrink-0">{label}</span>
      <span className="text-cafe-black font-semibold w-8 text-right">{rate}%</span>
      <div className="flex-1 h-2.5 rounded-full bg-[var(--console-panel-bg)] overflow-hidden">
        <div className={`h-full rounded-full ${color} transition-all`} style={{ width: `${pct}%` }} />
      </div>
    </div>
  );
}
