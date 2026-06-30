/**
 * F153 Phase K: Pure logic helpers for observability panels.
 *
 * Extracted from HubObservabilityTab.tsx to keep files under the
 * 350-line hard limit and enable direct unit testing.
 */

export interface HealthData {
  status: 'healthy' | 'degraded';
  uptime: number;
  otelEnabled: boolean;
  disabledReason?: string;
  readiness?: { status: 'ready' | 'degraded'; checks: Record<string, { ok: boolean; ms: number; error?: string }> };
  errorRate: number | null;
  traceStore: { spanCount: number; maxSpans: number; oldestStoredAt: number | null } | null;
  metricsSnapshotStore: { snapshotCount: number; maxSnapshots: number } | null;
  timestamp: number;
}

export interface MetricsSnapshot {
  timestamp: number;
  metrics: Record<string, number>;
}

export interface EnvVar {
  name: string;
  defaultValue: string;
  description: string;
  category: string;
  sensitive: boolean;
  currentValue: string | null;
  allowedValues?: string[];
  runtimeEditable?: boolean;
}

export const TELEMETRY_CATEGORY = 'telemetry';

/** Filter to telemetry-category hot-reloadable vars (toggles + editable fields) */
export function filterTelemetryEditable(vars: EnvVar[]): EnvVar[] {
  return vars.filter((v) => v.category === TELEMETRY_CATEGORY && !v.sensitive && v.runtimeEditable === true);
}

/** Return telemetry-category vars that are startup-only (read-only config reference) */
export function getTelemetryConfigVars(vars: EnvVar[]): EnvVar[] {
  return vars.filter((v) => v.category === TELEMETRY_CATEGORY && v.runtimeEditable !== true);
}

export function sumByPrefix(metrics: Record<string, number>, prefix: string, filter?: string): number {
  let total = 0;
  for (const [key, value] of Object.entries(metrics)) {
    if (!key.startsWith(prefix)) continue;
    if (filter && !key.includes(filter)) continue;
    total += value;
  }
  return total;
}

export function formatUptime(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  return h > 0 ? `${h}h ${m}m` : `${m}m`;
}
