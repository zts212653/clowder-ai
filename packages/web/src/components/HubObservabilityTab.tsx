'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { apiFetch } from '@/utils/api-client';

interface HealthData {
  uptime: number;
  traceStore: { spanCount: number; maxSpans: number; oldestStoredAt: number | null } | null;
  metricsSnapshotStore: { snapshotCount: number; maxSnapshots: number } | null;
  otelEnabled: boolean;
  timestamp: number;
}

interface TraceSpan {
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  name: string;
  durationMs: number;
  status: { code: number; message?: string };
  attributes: Record<string, unknown>;
  startTimeMs: number;
  endTimeMs: number;
  events: ReadonlyArray<{ name: string; timeMs: number; attributes?: Record<string, unknown> }>;
}

interface MetricsSnapshot {
  timestamp: number;
  metrics: Record<string, number>;
}

type SubTab = 'overview' | 'traces' | 'health';

export function HubObservabilityTab() {
  const [subTab, setSubTab] = useState<SubTab>('overview');

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2 border-b border-cafe-border pb-2">
        {(['overview', 'traces', 'health'] as SubTab[]).map((t) => (
          <button
            key={t}
            onClick={() => setSubTab(t)}
            className={`rounded-lg px-3 py-1.5 text-xs font-medium transition-colors ${
              subTab === t ? 'bg-blue-50 text-blue-700' : 'text-cafe-secondary hover:bg-cafe-surface-elevated'
            }`}
          >
            {{ overview: '总览', traces: 'Traces', health: '健康' }[t]}
          </button>
        ))}
      </div>

      {subTab === 'overview' && <OverviewPanel />}
      {subTab === 'traces' && <TraceBrowser />}
      {subTab === 'health' && <HealthPanel />}
    </div>
  );
}

function MetricCard({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="rounded-lg bg-cafe-surface-elevated px-4 py-3">
      <div className="text-xs text-cafe-muted">{label}</div>
      <div className="mt-1 text-xl font-semibold text-cafe">{value}</div>
      {sub && <div className="text-xs text-cafe-secondary">{sub}</div>}
    </div>
  );
}

function OverviewPanel() {
  const [snapshots, setSnapshots] = useState<MetricsSnapshot[]>([]);
  const [loading, setLoading] = useState(true);
  const timerRef = useRef<ReturnType<typeof setInterval>>();

  const fetchHistory = useCallback(async () => {
    try {
      const since = Date.now() - 30 * 60 * 1000;
      const res = await apiFetch(`/api/telemetry/metrics/history?since=${since}`);
      if (res.ok) {
        const data = (await res.json()) as { snapshots: MetricsSnapshot[] };
        setSnapshots(data.snapshots);
      }
    } catch {
      /* ignore */
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchHistory();
    timerRef.current = setInterval(fetchHistory, 30_000);
    return () => clearInterval(timerRef.current);
  }, [fetchHistory]);

  const latest = snapshots.length > 0 ? snapshots[snapshots.length - 1]!.metrics : {};

  const taskOk = sumByPrefix(latest, 'cat_cafe_task_completed', 'status="ok"');
  const taskErr = sumByPrefix(latest, 'cat_cafe_task_completed', 'status="error"');
  const invocations = sumByPrefix(latest, 'cat_cafe_cat_invocation_count');

  if (loading) return <p className="text-sm text-cafe-muted">...</p>;

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <MetricCard label="Task (ok)" value={String(taskOk)} />
        <MetricCard
          label="Task (error)"
          value={String(taskErr)}
          sub={taskOk + taskErr > 0 ? `${((taskErr / (taskOk + taskErr)) * 100).toFixed(1)}% error` : undefined}
        />
        <MetricCard label="Invocations" value={String(invocations)} />
        <MetricCard label="Snapshots" value={`${snapshots.length}`} sub="(last 30min)" />
      </div>

      {snapshots.length > 1 && (
        <TrendChart snapshots={snapshots} metricPrefix="cat_cafe_task_completed" label="Task Completed" />
      )}
    </div>
  );
}

function TrendChart({
  snapshots,
  metricPrefix,
  label,
}: {
  snapshots: MetricsSnapshot[];
  metricPrefix: string;
  label: string;
}) {
  if (snapshots.length < 2) return null;

  const values = snapshots.map((s) => sumByPrefix(s.metrics, metricPrefix));
  const max = Math.max(...values, 1);
  const width = 400;
  const height = 80;
  const step = width / (values.length - 1);

  const points = values.map((v, i) => `${i * step},${height - (v / max) * height}`).join(' ');

  return (
    <div className="rounded-lg bg-cafe-surface-elevated p-3">
      <div className="mb-2 text-xs text-cafe-muted">{label}</div>
      <svg viewBox={`0 0 ${width} ${height}`} className="h-20 w-full" preserveAspectRatio="none">
        <polyline points={points} fill="none" stroke="#5B9BD5" strokeWidth="2" />
      </svg>
    </div>
  );
}

function TraceBrowser() {
  const [spans, setSpans] = useState<TraceSpan[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [expanded, setExpanded] = useState<string | null>(null);

  const fetchTraces = useCallback(async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams({ limit: '100' });
      if (search) {
        if (search.length === 32 && /^[0-9a-f]+$/.test(search)) {
          params.set('traceId', search);
        } else {
          params.set('catId', search);
        }
      }
      const res = await apiFetch(`/api/telemetry/traces?${params}`);
      if (res.ok) {
        const data = (await res.json()) as { spans: TraceSpan[] };
        setSpans(data.spans);
      }
    } catch {
      /* ignore */
    } finally {
      setLoading(false);
    }
  }, [search]);

  useEffect(() => {
    fetchTraces();
  }, [fetchTraces]);

  return (
    <div className="space-y-3">
      <div className="flex gap-2">
        <input
          type="text"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="traceId or catId..."
          className="flex-1 rounded-lg border border-cafe-border bg-cafe-surface px-3 py-1.5 text-sm text-cafe placeholder:text-cafe-muted focus:border-blue-400 focus:outline-none"
        />
        <button
          onClick={fetchTraces}
          className="rounded-lg bg-blue-50 px-3 py-1.5 text-xs font-medium text-blue-700 hover:bg-blue-100"
        >
          Search
        </button>
      </div>

      {loading ? (
        <p className="text-sm text-cafe-muted">...</p>
      ) : spans.length === 0 ? (
        <p className="text-sm text-cafe-secondary">No traces found.</p>
      ) : (
        <div className="max-h-[400px] overflow-y-auto rounded-lg border border-cafe-border">
          <table className="w-full text-xs">
            <thead>
              <tr className="border-b border-cafe-border bg-cafe-surface-elevated text-left text-cafe-muted">
                <th className="px-3 py-2">Name</th>
                <th className="px-3 py-2">Cat</th>
                <th className="px-3 py-2">Duration</th>
                <th className="px-3 py-2">Status</th>
                <th className="px-3 py-2">Time</th>
              </tr>
            </thead>
            <tbody>
              {spans.map((span) => (
                <SpanRow
                  key={span.spanId}
                  span={span}
                  expanded={expanded === span.spanId}
                  onToggle={() => setExpanded(expanded === span.spanId ? null : span.spanId)}
                />
              ))}
            </tbody>
          </table>
        </div>
      )}

      {expanded && (
        <SpanWaterfall spans={spans.filter((s) => s.traceId === spans.find((sp) => sp.spanId === expanded)?.traceId)} />
      )}
    </div>
  );
}

function SpanRow({ span, expanded, onToggle }: { span: TraceSpan; expanded: boolean; onToggle: () => void }) {
  const catId = span.attributes['agent.id'] as string | undefined;
  const statusOk = span.status.code === 0 || span.status.code === 1;

  return (
    <>
      <tr
        onClick={onToggle}
        className={`cursor-pointer border-b border-cafe-border transition-colors hover:bg-cafe-surface-elevated ${expanded ? 'bg-blue-50/50' : ''}`}
      >
        <td className="px-3 py-2 font-mono">{span.name}</td>
        <td className="px-3 py-2">{catId ?? '-'}</td>
        <td className="px-3 py-2 tabular-nums">{span.durationMs.toFixed(0)}ms</td>
        <td className="px-3 py-2">
          <span
            className={`rounded px-1.5 py-0.5 text-[10px] font-medium ${statusOk ? 'bg-green-50 text-green-700' : 'bg-red-50 text-red-700'}`}
          >
            {statusOk ? 'ok' : 'error'}
          </span>
        </td>
        <td className="px-3 py-2 text-cafe-muted">{new Date(span.startTimeMs).toLocaleTimeString()}</td>
      </tr>
      {expanded && (
        <tr>
          <td colSpan={5} className="bg-cafe-surface-elevated px-4 py-3">
            <div className="space-y-1 text-xs">
              <div>
                <span className="text-cafe-muted">traceId:</span> <span className="font-mono">{span.traceId}</span>
              </div>
              <div>
                <span className="text-cafe-muted">spanId:</span> <span className="font-mono">{span.spanId}</span>
              </div>
              {span.parentSpanId && (
                <div>
                  <span className="text-cafe-muted">parentSpanId:</span>{' '}
                  <span className="font-mono">{span.parentSpanId}</span>
                </div>
              )}
              {Object.entries(span.attributes).length > 0 && (
                <div className="mt-2">
                  <div className="mb-1 text-cafe-muted">Attributes:</div>
                  {Object.entries(span.attributes).map(([k, v]) => (
                    <div key={k} className="ml-2">
                      <span className="text-cafe-muted">{k}:</span> {String(v)}
                    </div>
                  ))}
                </div>
              )}
              {span.events.length > 0 && (
                <div className="mt-2">
                  <div className="mb-1 text-cafe-muted">Events ({span.events.length}):</div>
                  {span.events.map((ev, i) => (
                    <div key={i} className="ml-2">
                      {new Date(ev.timeMs).toLocaleTimeString()} - {ev.name}
                    </div>
                  ))}
                </div>
              )}
            </div>
          </td>
        </tr>
      )}
    </>
  );
}

function SpanWaterfall({ spans }: { spans: TraceSpan[] }) {
  if (spans.length <= 1) return null;

  const minStart = Math.min(...spans.map((s) => s.startTimeMs));
  const maxEnd = Math.max(...spans.map((s) => s.endTimeMs));
  const totalDuration = maxEnd - minStart || 1;

  const sorted = [...spans].sort((a, b) => a.startTimeMs - b.startTimeMs);

  return (
    <div className="rounded-lg bg-cafe-surface-elevated p-3">
      <div className="mb-2 text-xs text-cafe-muted">Span Waterfall (traceId: {sorted[0]?.traceId?.slice(0, 8)}...)</div>
      <div className="space-y-1">
        {sorted.map((span) => {
          const left = ((span.startTimeMs - minStart) / totalDuration) * 100;
          const width = Math.max((span.durationMs / totalDuration) * 100, 0.5);
          const statusOk = span.status.code === 0 || span.status.code === 1;

          return (
            <div key={span.spanId} className="flex items-center gap-2">
              <div className="w-32 truncate text-[10px] text-cafe-muted" title={span.name}>
                {span.name}
              </div>
              <div className="relative h-4 flex-1 rounded bg-cafe-surface">
                <div
                  className={`absolute h-full rounded ${statusOk ? 'bg-blue-400' : 'bg-red-400'}`}
                  style={{ left: `${left}%`, width: `${width}%` }}
                  title={`${span.durationMs.toFixed(0)}ms`}
                />
              </div>
              <div className="w-16 text-right text-[10px] tabular-nums text-cafe-muted">
                {span.durationMs.toFixed(0)}ms
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function HealthPanel() {
  const [health, setHealth] = useState<HealthData | null>(null);
  const [loading, setLoading] = useState(true);

  const fetchHealth = useCallback(async () => {
    try {
      const res = await apiFetch('/api/telemetry/health');
      if (res.ok) setHealth((await res.json()) as HealthData);
    } catch {
      /* ignore */
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchHealth();
  }, [fetchHealth]);

  if (loading) return <p className="text-sm text-cafe-muted">...</p>;
  if (!health) return <p className="text-sm text-cafe-secondary">Unable to load health data.</p>;

  return (
    <div className="space-y-3">
      <div className="grid grid-cols-2 gap-3">
        <MetricCard label="Uptime" value={formatUptime(health.uptime)} />
        <MetricCard label="OTel" value={health.otelEnabled ? 'Enabled' : 'Disabled'} />
        <MetricCard
          label="Trace Store"
          value={health.traceStore ? `${health.traceStore.spanCount} spans` : 'N/A'}
          sub={health.traceStore ? `max ${health.traceStore.maxSpans}` : undefined}
        />
        <MetricCard
          label="Snapshot Store"
          value={health.metricsSnapshotStore ? `${health.metricsSnapshotStore.snapshotCount} snapshots` : 'N/A'}
          sub={health.metricsSnapshotStore ? `max ${health.metricsSnapshotStore.maxSnapshots}` : undefined}
        />
      </div>
      {health.traceStore?.oldestStoredAt && (
        <div className="text-xs text-cafe-muted">
          Oldest span: {new Date(health.traceStore.oldestStoredAt).toLocaleString()}
        </div>
      )}
    </div>
  );
}

function sumByPrefix(metrics: Record<string, number>, prefix: string, filter?: string): number {
  let total = 0;
  for (const [key, value] of Object.entries(metrics)) {
    if (!key.startsWith(prefix)) continue;
    if (filter && !key.includes(filter)) continue;
    total += value;
  }
  return total;
}

function formatUptime(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  return h > 0 ? `${h}h ${m}m` : `${m}m`;
}
