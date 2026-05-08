'use client';

import type React from 'react';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { apiFetch } from '@/utils/api-client';
import { SettingsResourceToggleSwitch, settingsResourceCardClass } from '../SettingsResourceCard';

interface RawStatusResponse {
  backend: string;
  healthy: boolean;
  docs_count?: number;
  threads_count?: number;
  passages_count?: number;
  edges_count?: number;
  last_rebuild_at?: string | null;
  embedding_model?: string | null;
  reason?: string;
}

export interface IndexStatusData {
  backend: string;
  healthy: boolean;
  docsCount: number;
  threadsCount: number;
  passagesCount: number;
  edgesCount: number;
  lastRebuildAt: string | null;
  embeddingModel: string | null;
  reason?: string;
}

/**
 * Pure: parse raw API response into normalized status data.
 */
export function parseIndexStatus(raw: RawStatusResponse): IndexStatusData {
  return {
    backend: raw.backend,
    healthy: raw.healthy,
    docsCount: raw.docs_count ?? 0,
    threadsCount: raw.threads_count ?? 0,
    passagesCount: raw.passages_count ?? 0,
    edgesCount: raw.edges_count ?? 0,
    lastRebuildAt: raw.last_rebuild_at ?? null,
    embeddingModel: raw.embedding_model ?? null,
    reason: raw.reason,
  };
}

// ── Env Config types + helpers ──

interface EnvVar {
  name: string;
  defaultValue: string;
  description: string;
  category: string;
  sensitive: boolean;
  currentValue: string | null;
}

interface EnvSummaryResponse {
  variables: EnvVar[];
}

const EVIDENCE_CATEGORY = 'evidence';

/** Pure: filter to evidence-category on/off toggle flags only (excludes URLs, paths, ports) */
export function filterEvidenceVars(vars: EnvVar[]): EnvVar[] {
  return vars.filter(
    (v) => v.category === EVIDENCE_CATEGORY && !v.sensitive && (v.defaultValue === 'off' || v.defaultValue === 'on'),
  );
}

/** Pure: return evidence-category vars that are NOT toggles (URLs, paths, ports, sensitive keys) */
export function getConfigVars(vars: EnvVar[]): EnvVar[] {
  return vars.filter((v) => v.category === EVIDENCE_CATEGORY && v.defaultValue !== 'off' && v.defaultValue !== 'on');
}

function StatusRow({ label, value }: { label: string; value: string | number }) {
  return (
    <div className="flex items-center gap-3 px-1 py-2.5 text-xs">
      <span className="flex-1 text-cafe-muted">{label}</span>
      <span className="font-medium text-cafe">{String(value)}</span>
    </div>
  );
}

function CollapsibleGroup({ label, count, children }: { label: string; count: number; children: React.ReactNode }) {
  const [collapsed, setCollapsed] = useState(false);
  return (
    <div className="console-list-card rounded-2xl shadow-[0_4px_16px_rgba(43,33,26,0.05)] overflow-hidden">
      <button
        type="button"
        onClick={() => setCollapsed((c) => !c)}
        className="flex w-full items-center gap-2.5 px-4 py-3 text-left transition-colors hover:bg-[var(--console-hover-bg)]"
      >
        <span
          className="text-[11px] text-cafe-muted transition-transform"
          style={{ transform: collapsed ? 'rotate(-90deg)' : 'rotate(0deg)' }}
        >
          ▾
        </span>
        <span className="text-[13px] font-semibold text-cafe">{label}</span>
        <span className="console-pill rounded-full px-2 py-0.5 text-[10px] font-semibold text-cafe-muted">{count}</span>
      </button>
      {!collapsed && <div className="divide-y divide-[var(--console-border-soft)] px-4 pb-2">{children}</div>}
    </div>
  );
}

export function IndexStatus() {
  const [status, setStatus] = useState<IndexStatusData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [envVars, setEnvVars] = useState<EnvVar[]>([]);
  const [updatingKey, setUpdatingKey] = useState<string | null>(null);

  const evidenceVars = useMemo(() => filterEvidenceVars(envVars), [envVars]);
  const configVars = useMemo(() => getConfigVars(envVars), [envVars]);

  const fetchAll = useCallback(async () => {
    try {
      const [statusRes, envRes] = await Promise.all([
        apiFetch('/api/evidence/status'),
        apiFetch('/api/config/env-summary'),
      ]);
      const raw = (await statusRes.json()) as RawStatusResponse;
      setStatus(parseIndexStatus(raw));
      const envData = (await envRes.json()) as EnvSummaryResponse;
      setEnvVars(envData.variables ?? []);
      setError(null);
    } catch {
      setError('Failed to fetch memory status');
    }
  }, []);

  const toggleEnvVar = useCallback(
    async (name: string, currentValue: string | null) => {
      setUpdatingKey(name);
      const newValue = currentValue === 'on' ? 'off' : 'on';
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

  useEffect(() => {
    fetchAll();
  }, [fetchAll]);

  if (error) {
    return (
      <div data-testid="index-status" className="rounded-[20px] border border-conn-red-ring bg-conn-red-bg p-4">
        <p className="text-sm text-conn-red-text">{error}</p>
        <button type="button" onClick={fetchAll} className="mt-2 text-xs text-conn-red-text underline">
          重试
        </button>
      </div>
    );
  }

  if (!status) {
    return (
      <div data-testid="index-status" className="p-4">
        <p className="text-sm text-cafe-secondary">Loading...</p>
      </div>
    );
  }

  const statsCount = 5 + (status.embeddingModel ? 1 : 0) + 1;

  return (
    <div data-testid="index-status" className={`${settingsResourceCardClass} p-[18px]`}>
      <div className="flex items-center gap-2 mb-3">
        <span
          className={`inline-block h-2.5 w-2.5 rounded-full ${status.healthy ? 'bg-conn-emerald-text' : 'bg-conn-red-text'}`}
        />
        <span className="text-[13px] font-semibold text-cafe">{status.healthy ? 'Healthy' : 'Unhealthy'}</span>
        {status.reason && <span className="text-xs text-cafe-muted">({status.reason})</span>}
      </div>

      <div className="space-y-2.5">
        <CollapsibleGroup label="索引统计" count={statsCount}>
          <StatusRow label="Backend" value={status.backend} />
          <StatusRow label="Documents" value={status.docsCount} />
          <StatusRow label="Threads" value={status.threadsCount} />
          <StatusRow label="Passages" value={status.passagesCount} />
          <StatusRow label="Edges" value={status.edgesCount} />
          {status.embeddingModel && <StatusRow label="Embedding" value={status.embeddingModel} />}
          <StatusRow
            label="Last rebuild"
            value={status.lastRebuildAt ? new Date(status.lastRebuildAt).toLocaleString() : 'Never'}
          />
        </CollapsibleGroup>

        {evidenceVars.length > 0 && (
          <CollapsibleGroup label="功能开关" count={evidenceVars.length}>
            {evidenceVars.map((v) => {
              const isOn = v.currentValue === 'on';
              const isBinary = v.currentValue === 'on' || v.currentValue === 'off' || v.currentValue == null;
              const isUpdating = updatingKey === v.name;
              return (
                <div key={v.name} className="flex items-center gap-3 px-1 py-2.5 text-xs">
                  <div className="min-w-0 flex-1 space-y-0.5">
                    <code className="font-mono font-semibold text-cafe">{v.name}</code>
                    <p className="text-[11px] text-cafe-muted">{v.description}</p>
                  </div>
                  {isBinary ? (
                    <SettingsResourceToggleSwitch
                      enabled={isOn}
                      busy={isUpdating}
                      onClick={() => toggleEnvVar(v.name, v.currentValue)}
                    />
                  ) : (
                    <span className="rounded bg-conn-amber-bg px-1.5 py-0.5 text-[10px] font-medium text-conn-amber-text">
                      {v.currentValue}
                    </span>
                  )}
                </div>
              );
            })}
          </CollapsibleGroup>
        )}

        {configVars.length > 0 && (
          <CollapsibleGroup label="配置参考" count={configVars.length}>
            {configVars.map((v) => (
              <div key={v.name} className="flex items-center gap-3 px-1 py-2.5 text-xs">
                <div className="min-w-0 flex-1 space-y-0.5">
                  <code className="font-mono font-semibold text-cafe">{v.name}</code>
                  <p className="text-[11px] text-cafe-muted">{v.description}</p>
                </div>
                <span className="shrink-0 font-mono text-cafe-muted truncate max-w-[50%] text-right">
                  {v.sensitive ? '••••••' : v.currentValue || v.defaultValue}
                </span>
              </div>
            ))}
          </CollapsibleGroup>
        )}
      </div>

      <button type="button" onClick={fetchAll} className="console-button-ghost text-xs px-3 py-1.5 mt-3">
        刷新状态
      </button>
    </div>
  );
}
