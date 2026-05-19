/**
 * ToolUsageMetricsPanel — F188 Phase F (AC-F9)
 *
 * Memory Health Dashboard panel for Phase F observability metrics.
 * Fetches /api/library/tool-usage-metrics, renders 7 metrics with
 * N≥20 threshold guard (shows "insufficient data" when sample too small).
 */

import { useEffect, useState } from 'react';

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

function MetricRow({ label, metric, hint }: { label: string; metric: ToolUsageMetric; hint?: string }) {
  const display =
    metric.sufficient && metric.value !== null
      ? `${metric.value.toFixed(1)}${metric.unit}`
      : `insufficient data (N=${metric.sampleN}, need ≥${metric.threshold})`;
  const color = metric.sufficient ? 'text-cafe-black' : 'text-cafe-muted italic';
  return (
    <div className="flex items-baseline justify-between border-b border-cafe/30 py-2 last:border-0">
      <div>
        <div className="text-xs font-medium text-cafe-black">{label}</div>
        {hint ? <div className="text-[10px] text-cafe-muted">{hint}</div> : null}
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

  useEffect(() => {
    const load =
      fetcher ??
      (async () => {
        const res = await fetch('/api/library/tool-usage-metrics');
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return res.json();
      });
    load()
      .then((r) => setReport(r as ToolUsageMetricsReport))
      .catch((e) => setError(e instanceof Error ? e.message : String(e)));
  }, [fetcher]);

  if (error) {
    return (
      <div className="rounded-xl border border-cafe bg-white p-5" data-testid="tool-usage-metrics-error">
        <h4 className="mb-2 text-sm font-semibold text-cafe-black">Tool Usage Metrics (F188 Phase F)</h4>
        <div className="text-xs text-conn-red-text">Failed to load: {error}</div>
      </div>
    );
  }

  if (!report) {
    return (
      <div className="rounded-xl border border-cafe bg-white p-5" data-testid="tool-usage-metrics-loading">
        <h4 className="mb-2 text-sm font-semibold text-cafe-black">Tool Usage Metrics (F188 Phase F)</h4>
        <div className="text-xs text-cafe-muted">Loading…</div>
      </div>
    );
  }

  return (
    <div className="rounded-xl border border-cafe bg-white p-5" data-testid="tool-usage-metrics-panel">
      <div className="mb-3 flex items-baseline justify-between">
        <h4 className="text-sm font-semibold text-cafe-black">Tool Usage Metrics (F188 Phase F)</h4>
        <div className="text-[10px] text-cafe-muted">
          {report.threadCount} thread(s) · {new Date(report.generatedAt).toLocaleString()}
        </div>
      </div>
      <div className="space-y-0">
        <div className="mb-2 text-[10px] font-semibold uppercase tracking-wide text-cafe-secondary">
          Three-Entry Distribution
        </div>
        <MetricRow label="search_evidence" metric={report.distribution.searchEvidence} />
        <MetricRow label="graph_resolve" metric={report.distribution.graphResolve} />
        <MetricRow label="list_recent" metric={report.distribution.listRecent} />

        <div className="mt-3 mb-2 text-[10px] font-semibold uppercase tracking-wide text-cafe-secondary">
          Friction Metrics
        </div>
        <MetricRow
          label="grep after search rate"
          metric={report.grepAfterSearchRate}
          hint="FM-1: search → Bash grep within 5 turns. Target: <30%"
        />
        <MetricRow
          label="candidate selection (non-first)"
          metric={report.candidateSelectionDistribution}
          hint="FM-2: graph_resolve candidate ranking quality. Target: <50%"
        />
        <MetricRow
          label="list_recent adoption rate"
          metric={report.listRecentAdoptionRate}
          hint="FM-3: cold-start uses list_recent. Target: ≥5%"
        />
        <MetricRow
          label="nudge failure rate"
          metric={report.nudgeFailureRate}
          hint="FM-5: nudge sent but cat falls back to grep. Target: <40%"
        />
      </div>
    </div>
  );
}
