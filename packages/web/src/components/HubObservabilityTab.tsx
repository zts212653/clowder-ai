'use client';

import { useCallback, useEffect, useState } from 'react';
import { apiFetch } from '@/utils/api-client';
import { HubCallbackAuthPanel } from './HubCallbackAuthPanel';
import { HubEvalTab } from './HubEvalTab';
import { MetricCard, OverviewPanel } from './HubObservabilityOverview';
import { TraceBrowser } from './HubTraceTree';
import type { HealthData } from './observability-helpers';
import { formatUptime } from './observability-helpers';

type SubTab = 'overview' | 'traces' | 'health' | 'callback-auth' | 'eval';

const SUB_TAB_LABELS: Record<SubTab, string> = {
  overview: '总览',
  traces: 'Traces',
  health: '健康',
  'callback-auth': 'Callback Auth',
  eval: 'Eval',
};

const SUB_TABS: SubTab[] = ['overview', 'traces', 'health', 'callback-auth', 'eval'];

export interface HubObservabilityTabProps {
  /** F174 D2b-3: open directly into a specific subtab (e.g. when D2b-1 详情 button navigates here). */
  initialSubTab?: SubTab;
  /**
   * F174 D2b-3 cloud P2 #1403: per-navigation nonce. Bumps on every deep-link,
   * so a second navigation with SAME (tab, subTab) still re-syncs subTab. Without
   * this, value-only diff in the useEffect below would silently no-op when a
   * user manually navigated away and then re-clicked 详情.
   */
  subTabNonce?: number;
}

export function HubObservabilityTab({ initialSubTab = 'overview', subTabNonce }: HubObservabilityTabProps = {}) {
  const [subTab, setSubTab] = useState<SubTab>(initialSubTab);

  // Sync prop → state on every initialSubTab change OR per-invocation nonce
  // bump. The nonce dep handles the same-value re-deep-link case (cloud P2).
  useEffect(() => {
    setSubTab(initialSubTab);
  }, [initialSubTab, subTabNonce]);

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2" data-guide-id="observability.subtabs">
        {SUB_TABS.map((t) => (
          <button
            key={t}
            type="button"
            onClick={() => setSubTab(t)}
            data-guide-id={`observability.${t}`}
            className={`px-3 py-1.5 text-xs transition-colors ${
              subTab === t
                ? 'border-b-2 border-[var(--console-button-emphasis)] font-semibold text-[var(--console-button-emphasis)]'
                : 'font-medium text-cafe-muted hover:text-cafe-secondary'
            }`}
          >
            {SUB_TAB_LABELS[t]}
          </button>
        ))}
      </div>

      {subTab === 'overview' && <OverviewPanel />}
      {subTab === 'traces' && <TraceBrowser />}
      {subTab === 'health' && <HealthPanel />}
      {subTab === 'callback-auth' && <HubCallbackAuthPanel />}
      {subTab === 'eval' && <HubEvalTab />}
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
    <div className="space-y-3" data-guide-id="observability.health-panel">
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
              <span className={check.ok ? 'text-conn-green-text' : 'text-conn-red-text'}>{check.ok ? '✓' : '✗'}</span>
              <span className="text-cafe">{name}</span>
              <span className="text-cafe-muted">{check.ms}ms</span>
              {check.error && <span className="text-conn-red-text">{check.error}</span>}
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
