/**
 * ToolUsageMetricsPanel — F188 Phase F (AC-F9)
 *
 * Memory Health Dashboard panel for Phase F observability metrics.
 * Fetches /api/library/tool-usage-metrics, renders 7 metrics with
 * N≥20 threshold guard (shows "insufficient data" when sample too small).
 */

import { useEffect, useState } from 'react';
import { apiFetch } from '@/utils/api-client';
import { MemoryReadError } from './page/MemoryReadError';
import { memoryTime } from './page/memory-time';

interface ToolUsageMetric {
  value: number | null;
  unit: string;
  sampleN: number;
  sufficient: boolean;
  threshold: number;
}

interface ToolUsageMetricsReport {
  generatedAt: string;
  threadCount: number;
  distribution: {
    searchEvidence: ToolUsageMetric;
    graphResolve: ToolUsageMetric;
    listRecent: ToolUsageMetric;
  };
  grepAfterSearchRate: ToolUsageMetric;
  candidateSelectionDistribution: ToolUsageMetric;
  listRecentAdoptionRate: ToolUsageMetric;
  nudgeFailureRate: ToolUsageMetric;
}

function isMetricsReport(value: unknown): value is ToolUsageMetricsReport {
  if (!value || typeof value !== 'object') return false;
  const report = value as ToolUsageMetricsReport;
  if (!report.distribution || !Number.isSafeInteger(report.threadCount) || typeof report.generatedAt !== 'string')
    return false;
  return [
    report.distribution.searchEvidence,
    report.distribution.graphResolve,
    report.distribution.listRecent,
    report.grepAfterSearchRate,
    report.candidateSelectionDistribution,
    report.listRecentAdoptionRate,
    report.nudgeFailureRate,
  ].every(
    (metric) =>
      metric &&
      (metric.value === null || Number.isFinite(metric.value)) &&
      Number.isSafeInteger(metric.sampleN) &&
      metric.sampleN >= 0 &&
      Number.isFinite(metric.threshold) &&
      typeof metric.sufficient === 'boolean' &&
      typeof metric.unit === 'string',
  );
}

function MetricRow({ label, metric, hint }: { label: string; metric: ToolUsageMetric; hint?: string }) {
  const display =
    metric.sufficient && metric.value !== null
      ? `${metric.value.toFixed(1)}${metric.unit}`
      : `样本不足：${metric.sampleN} / ${metric.threshold}`;
  const color = metric.sufficient ? 'text-cafe-black' : 'text-cafe-muted';
  return (
    <div className="flex flex-wrap items-baseline justify-between gap-2 console-divider-b py-2 last:border-0">
      <div className="min-w-0 flex-1">
        <div className="text-xs font-medium text-cafe-black">{label}</div>
        {hint ? <div className="text-micro text-cafe-muted">{hint}</div> : null}
      </div>
      <div className={`text-sm font-mono ${color}`} data-testid={`metric-${label.replace(/\s+/g, '-').toLowerCase()}`}>
        {display}
      </div>
    </div>
  );
}

export function ToolUsageMetricsPanel({ fetcher }: { fetcher?: () => Promise<ToolUsageMetricsReport> }) {
  const [report, setReport] = useState<ToolUsageMetricsReport | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setReport(null);
    setError(null);
    const load =
      fetcher ??
      (async () => {
        const res = await apiFetch('/api/library/tool-usage-metrics');
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return res.json();
      });
    load()
      .then((value: unknown) => {
        if (!isMetricsReport(value)) throw new Error('读取结果不完整');
        if (!cancelled) setReport(value);
      })
      .catch(() => {
        if (!cancelled) setError('暂时读不到工具使用指标');
      });
    return () => {
      cancelled = true;
    };
  }, [fetcher, attempt]);

  if (error) {
    return (
      <div className="rounded-xl bg-[var(--console-card-bg)] p-5" data-testid="tool-usage-metrics-error">
        <h4 className="mb-2 text-sm font-semibold text-cafe-black">工具使用指标</h4>
        <MemoryReadError noun="工具使用指标" retry={() => setAttempt((value) => value + 1)} />
      </div>
    );
  }

  if (!report) {
    return (
      <div className="rounded-xl bg-[var(--console-card-bg)] p-5" data-testid="tool-usage-metrics-loading">
        <h4 className="mb-2 text-sm font-semibold text-cafe-black">工具使用指标</h4>
        <div className="text-xs text-cafe-muted">加载中…</div>
      </div>
    );
  }

  return (
    <div className="rounded-xl bg-[var(--console-card-bg)] p-5" data-testid="tool-usage-metrics-panel">
      <div className="mb-3 flex items-baseline justify-between">
        <h4 className="text-sm font-semibold text-cafe-black">工具使用指标</h4>
        <div className="text-micro text-cafe-muted">
          {report.threadCount} 个线程 · {memoryTime(report.generatedAt)}
        </div>
      </div>
      <div className="space-y-0">
        <div className="mb-2 text-micro font-semibold uppercase tracking-wide text-cafe-secondary">三入口分布</div>
        <MetricRow label="search_evidence" metric={report.distribution.searchEvidence} />
        <MetricRow label="graph_resolve" metric={report.distribution.graphResolve} />
        <MetricRow label="list_recent" metric={report.distribution.listRecent} />

        <div className="mt-3 mb-2 text-micro font-semibold uppercase tracking-wide text-cafe-secondary">摩擦指标</div>
        <MetricRow
          label="搜索后 grep 比率"
          metric={report.grepAfterSearchRate}
          hint="搜索后 5 轮内回退 grep。目标: <30%"
        />
        <MetricRow
          label="候选项选择（非首选）"
          metric={report.candidateSelectionDistribution}
          hint="graph_resolve 候选排序质量。目标: <50%"
        />
        <MetricRow
          label="list_recent 采用率"
          metric={report.listRecentAdoptionRate}
          hint="冷启动使用 list_recent。目标: ≥5%"
        />
        <MetricRow label="提示失败率" metric={report.nudgeFailureRate} hint="已发提示但猫回退到 grep。目标: <40%" />
      </div>
    </div>
  );
}
