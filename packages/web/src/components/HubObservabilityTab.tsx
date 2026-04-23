'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { apiFetch } from '@/utils/api-client';
import { TraceBrowser } from './HubTraceTree';

interface HealthData {
  status: 'healthy' | 'degraded';
  uptime: number;
  otelEnabled: boolean;
  readiness?: { status: 'ready' | 'degraded'; checks: Record<string, { ok: boolean; ms: number; error?: string }> };
  errorRate: number | null;
  traceStore: { spanCount: number; maxSpans: number; oldestStoredAt: number | null } | null;
  metricsSnapshotStore: { snapshotCount: number; maxSnapshots: number } | null;
  timestamp: number;
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

  const invOk = sumByPrefix(latest, 'cat_cafe_invocation_completed', 'status="ok"');
  const invErr = sumByPrefix(latest, 'cat_cafe_invocation_completed', 'status="error"');
  const invocations = sumByPrefix(latest, 'cat_cafe_cat_invocation_count');
  const activeInv = sumByPrefix(latest, 'cat_cafe_invocation_active');

  if (loading) return <p className="text-sm text-cafe-muted">...</p>;

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <MetricCard label="Invocation (ok)" value={String(invOk)} />
        <MetricCard
          label="Invocation (error)"
          value={String(invErr)}
          sub={invOk + invErr > 0 ? `${((invErr / (invOk + invErr)) * 100).toFixed(1)}% error` : undefined}
        />
        <MetricCard label="Invocations" value={String(invocations)} />
        <MetricCard label="Active" value={String(activeInv)} />
        <MetricCard label="Snapshots" value={`${snapshots.length}`} sub="(last 30min)" />
      </div>

      {snapshots.length > 1 && (
        <TrendChart snapshots={snapshots} metricPrefix="cat_cafe_invocation_completed" label="Invocation Completed" />
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

function HealthPanel() {
  const [health, setHealth] = useState<HealthData | null>(null);
  const [loading, setLoading] = useState(true);

  const fetchHealth = useCallback(async () => {
    try {
      const res = await apiFetch('/api/telemetry/health');
      if (res.ok || res.status === 503) setHealth((await res.json()) as HealthData);
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
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <MetricCard label="Status" value={health.status === 'healthy' ? '✓ Healthy' : '⚠ Degraded'} />
        <MetricCard label="Uptime" value={formatUptime(health.uptime)} />
        <MetricCard label="OTel" value={health.otelEnabled ? 'Enabled' : 'Disabled'} />
        <MetricCard
          label="Error Rate"
          value={health.errorRate !== null ? `${(health.errorRate * 100).toFixed(1)}%` : 'N/A'}
        />
      </div>

      {health.readiness && (
        <div className="rounded-lg bg-cafe-surface-elevated p-3">
          <div className="mb-1 text-xs font-medium text-cafe-muted">Readiness Checks</div>
          {Object.entries(health.readiness.checks).map(([name, check]) => (
            <div key={name} className="flex items-center gap-2 text-xs">
              <span className={check.ok ? 'text-green-600' : 'text-red-500'}>{check.ok ? '✓' : '✗'}</span>
              <span className="text-cafe">{name}</span>
              <span className="text-cafe-muted">{check.ms}ms</span>
              {check.error && <span className="text-red-500">{check.error}</span>}
            </div>
          ))}
        </div>
      )}

      <div className="grid grid-cols-2 gap-3">
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
