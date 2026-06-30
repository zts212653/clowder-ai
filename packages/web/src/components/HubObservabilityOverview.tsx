'use client';

/**
 * F153 Phase K: OverviewPanel + supporting components for the
 * Observability tab's main view.
 *
 * Extracted from HubObservabilityTab.tsx to stay under the 350-line limit.
 */

import type React from 'react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { apiFetch } from '@/utils/api-client';
import type { EnvVar, HealthData, MetricsSnapshot } from './observability-helpers';
import { filterTelemetryEditable, getTelemetryConfigVars, sumByPrefix } from './observability-helpers';

export function MetricCard({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="rounded-lg bg-cafe-surface-elevated px-4 py-3">
      <div className="text-xs text-cafe-muted">{label}</div>
      <div className="mt-1 text-xl font-semibold text-cafe">{value}</div>
      {sub && <div className="text-xs text-cafe-secondary">{sub}</div>}
    </div>
  );
}

/**
 * Inline editable text field for hot-reloadable non-toggle env vars (AC-K3).
 *
 * `displayValue` is shown in read mode (may be a human-facing placeholder
 * like "(未設置 → 全部猫)"). `value` is the actual current env value used
 * to seed the edit input — keeps display placeholders out of `.env` writes.
 */
function InlineEditField({
  value,
  displayValue,
  disabled,
  onSubmit,
}: {
  value: string;
  displayValue?: string;
  disabled: boolean;
  onSubmit: (newVal: string) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(value);
  const inputRef = useRef<HTMLInputElement>(null);

  // Focus input when entering edit mode (replaces autoFocus for a11y)
  useEffect(() => {
    if (editing) inputRef.current?.focus();
  }, [editing]);

  if (!editing) {
    return (
      <button
        type="button"
        disabled={disabled}
        onClick={() => {
          setDraft(value);
          setEditing(true);
        }}
        className={`max-w-[50%] truncate rounded px-2 py-0.5 text-right font-mono text-micro text-cafe-secondary hover:bg-[var(--console-hover-bg)] ${disabled ? 'opacity-50' : ''}`}
        title="点击编辑"
      >
        {displayValue ?? value}
      </button>
    );
  }

  return (
    <form
      className="flex items-center gap-1"
      onSubmit={(e) => {
        e.preventDefault();
        if (draft !== value) onSubmit(draft);
        setEditing(false);
      }}
    >
      <input
        ref={inputRef}
        type="text"
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={() => setEditing(false)}
        onKeyDown={(e) => {
          if (e.key === 'Escape') setEditing(false);
        }}
        className="w-24 rounded border border-cafe-border bg-[var(--console-field-bg)] px-1.5 py-0.5 font-mono text-micro text-cafe-black outline-none focus:border-cafe-accent"
      />
    </form>
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
    <div
      className="rounded-lg bg-cafe-surface-elevated p-3"
      style={{ '--dataviz-trend-line': 'var(--chart-4)' } as React.CSSProperties}
    >
      <div className="mb-2 text-xs text-cafe-muted">{label}</div>
      <svg viewBox={`0 0 ${width} ${height}`} className="h-20 w-full" preserveAspectRatio="none">
        <polyline points={points} fill="none" stroke="var(--dataviz-trend-line)" strokeWidth="2" />
      </svg>
    </div>
  );
}

export function OverviewPanel() {
  const [snapshots, setSnapshots] = useState<MetricsSnapshot[]>([]);
  const [health, setHealth] = useState<HealthData | null>(null);
  const [envVars, setEnvVars] = useState<EnvVar[]>([]);
  const [loading, setLoading] = useState(true);
  const [updatingKey, setUpdatingKey] = useState<string | null>(null);
  const timerRef = useRef<ReturnType<typeof setInterval>>();

  const editableVars = useMemo(() => filterTelemetryEditable(envVars), [envVars]);
  const configVars = useMemo(() => getTelemetryConfigVars(envVars), [envVars]);

  const fetchAll = useCallback(async () => {
    try {
      const [historyRes, healthRes, envRes] = await Promise.all([
        apiFetch(`/api/telemetry/metrics/history?since=${Date.now() - 30 * 60 * 1000}`),
        apiFetch('/api/telemetry/health'),
        apiFetch('/api/config/env-summary'),
      ]);
      if (historyRes.ok) {
        const data = (await historyRes.json()) as { snapshots: MetricsSnapshot[] };
        setSnapshots(data.snapshots);
      }
      if (healthRes.ok || healthRes.status === 503) {
        setHealth((await healthRes.json()) as HealthData);
      }
      if (envRes.ok) {
        const envData = (await envRes.json()) as { variables: EnvVar[] };
        setEnvVars(envData.variables ?? []);
      }
    } catch {
      /* ignore — individual panel sections degrade gracefully */
    } finally {
      setLoading(false);
    }
  }, []);

  const patchEnvVar = useCallback(
    async (name: string, newValue: string) => {
      setUpdatingKey(name);
      try {
        await apiFetch('/api/config/env', {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ updates: [{ name, value: newValue }] }),
        });
        await fetchAll();
      } catch {
        /* fetchAll will refresh state */
      } finally {
        setUpdatingKey(null);
      }
    },
    [fetchAll],
  );

  const cycleEnvVar = useCallback(
    (name: string, currentValue: string | null, allowedValues?: string[]) => {
      let newValue: string;
      if (allowedValues && allowedValues.length > 1) {
        const idx = allowedValues.indexOf(currentValue ?? allowedValues[0]!);
        newValue = allowedValues[(idx + 1) % allowedValues.length]!;
      } else {
        newValue = currentValue === 'on' ? 'off' : 'on';
      }
      void patchEnvVar(name, newValue);
    },
    [patchEnvVar],
  );

  useEffect(() => {
    fetchAll();
    timerRef.current = setInterval(fetchAll, 30_000);
    return () => clearInterval(timerRef.current);
  }, [fetchAll]);

  const latest = snapshots.length > 0 ? snapshots[snapshots.length - 1]!.metrics : {};

  const invOk = sumByPrefix(latest, 'cat_cafe_invocation_completed', 'status="ok"');
  const invErr = sumByPrefix(latest, 'cat_cafe_invocation_completed', 'status="error"');
  const invocations = sumByPrefix(latest, 'cat_cafe_cat_invocation_count');
  const activeInv = sumByPrefix(latest, 'cat_cafe_invocation_active');

  if (loading) return <p className="text-sm text-cafe-muted">...</p>;

  const otelEnabled = health?.otelEnabled ?? false;

  return (
    <div className="space-y-4" data-guide-id="observability.overview-panel">
      {/* AC-K1 + AC-K2: OTel status banner with guidance when disabled */}
      {health && !otelEnabled && (
        <div className="rounded-lg border border-conn-amber-border bg-conn-amber-bg p-3">
          <div className="flex items-center gap-2">
            <span className="text-sm">⚠</span>
            <span className="text-xs font-semibold text-conn-amber-text">可观测性未启用</span>
          </div>
          <p className="mt-1 text-micro text-conn-amber-text">
            {health.disabledReason ? `原因：${health.disabledReason}。` : 'OTel SDK 未启动，监控数据不会采集。'}
            请在下方「配置参考」中检查相关配置，修改后需重启服务生效。
          </p>
        </div>
      )}

      {/* Metrics cards — always shown, will naturally be 0 when OTel disabled */}
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

      {/* AC-K3 + AC-K5: Feature toggles + editable hot-reloadable telemetry env vars */}
      {editableVars.length > 0 && (
        <div className="rounded-lg bg-[var(--console-card-bg)] p-3">
          <h3 className="mb-2 text-xs font-semibold text-cafe-black">功能开关</h3>
          {editableVars.map((v) => {
            const isToggle = v.allowedValues && v.allowedValues.length >= 2;
            const isOn = v.currentValue === 'on';
            const hasMultiValues = v.allowedValues && v.allowedValues.length > 2;
            const isUpdating = updatingKey === v.name;
            const current = v.currentValue ?? v.defaultValue;
            return (
              <div key={v.name} className="flex items-center justify-between rounded-lg px-2 py-2">
                <div className="flex-1 pr-3">
                  <div className="text-xs font-medium text-cafe-black">{v.name}</div>
                  <div className="text-micro text-cafe-secondary">{v.description}</div>
                </div>
                {isToggle && hasMultiValues ? (
                  <button
                    type="button"
                    disabled={isUpdating}
                    onClick={() => cycleEnvVar(v.name, v.currentValue, v.allowedValues)}
                    className={`rounded px-2 py-0.5 text-micro font-medium transition-colors ${
                      current === 'on' || current === 'apply'
                        ? 'bg-cafe-accent text-[var(--cafe-surface)] hover:bg-cafe-accent-hover'
                        : current === 'off'
                          ? 'bg-[var(--console-field-bg)] text-cafe-secondary hover:bg-[var(--console-hover-bg)]'
                          : 'bg-conn-amber-bg text-conn-amber-text hover:opacity-80'
                    } ${isUpdating ? 'opacity-50' : ''}`}
                    title={`点击切换: ${v.allowedValues!.join(' → ')}`}
                  >
                    {current}
                  </button>
                ) : isToggle ? (
                  <button
                    type="button"
                    disabled={isUpdating}
                    onClick={() => cycleEnvVar(v.name, v.currentValue)}
                    className={`relative h-5 w-9 rounded-full transition-colors ${isOn ? 'bg-cafe-accent' : 'bg-[var(--console-field-bg)]'} ${isUpdating ? 'opacity-50' : ''}`}
                  >
                    <span
                      className={`absolute top-0.5 left-0.5 h-4 w-4 rounded-full bg-[var(--cafe-surface)] shadow transition-transform ${isOn ? 'translate-x-4' : ''}`}
                    />
                  </button>
                ) : (
                  <InlineEditField
                    value={v.currentValue ?? ''}
                    displayValue={current}
                    disabled={isUpdating}
                    onSubmit={(newVal) => patchEnvVar(v.name, newVal)}
                  />
                )}
              </div>
            );
          })}
        </div>
      )}

      {/* AC-K4: Config reference — startup-only telemetry env vars */}
      {configVars.length > 0 && (
        <div className="rounded-lg bg-[var(--console-card-bg)] p-3">
          <h3 className="mb-2 text-xs font-semibold text-cafe-black">配置参考</h3>
          <p className="mb-2 text-micro text-cafe-secondary">以下配置需在 .env 中设置，修改后重启生效。</p>
          {configVars.map((v) => (
            <div key={v.name} className="rounded-lg px-2 py-2">
              <div className="flex items-center justify-between">
                <span className="font-mono text-xs font-medium text-cafe-black">{v.name}</span>
                <span className="max-w-[50%] truncate text-right font-mono text-micro text-cafe-secondary">
                  {v.sensitive ? '••••••' : v.currentValue || v.defaultValue}
                </span>
              </div>
              <div className="mt-0.5 text-micro text-cafe-secondary">{v.description}</div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
