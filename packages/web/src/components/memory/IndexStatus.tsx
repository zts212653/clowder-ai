'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { apiFetch } from '@/utils/api-client';

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
    <div className="flex items-center justify-between border-b border-cafe/50 py-2 last:border-b-0">
      <span className="text-xs text-cafe-secondary">{label}</span>
      <span className="text-sm font-medium text-cafe-black">{value}</span>
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
      <div data-testid="index-status" className="rounded-lg border border-red-200 bg-red-50 p-4">
        <p className="text-sm text-red-600">{error}</p>
        <button type="button" onClick={fetchAll} className="mt-2 text-xs text-red-700 underline">
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

  return (
    <div data-testid="index-status" className="space-y-4">
      {/* Health badge */}
      <div className="flex items-center gap-2">
        <span className={`inline-block h-2.5 w-2.5 rounded-full ${status.healthy ? 'bg-green-500' : 'bg-red-500'}`} />
        <span className="text-sm font-medium text-cafe-black">{status.healthy ? 'Healthy' : 'Unhealthy'}</span>
        {status.reason && <span className="text-xs text-cafe-secondary">({status.reason})</span>}
      </div>

      {/* Stats */}
      <div className="rounded-lg border border-cafe bg-white p-3">
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
      </div>

      {/* Feature flags */}
      {evidenceVars.length > 0 && (
        <div className="rounded-lg border border-cafe bg-white p-3">
          <h3 className="mb-2 text-xs font-semibold text-cafe-black">功能开关</h3>
          {evidenceVars.map((v) => {
            const isOn = v.currentValue === 'on';
            const isBinary = v.currentValue === 'on' || v.currentValue === 'off' || v.currentValue == null;
            const isUpdating = updatingKey === v.name;
            return (
              <div
                key={v.name}
                className="flex items-center justify-between border-b border-cafe/50 py-2 last:border-b-0"
              >
                <div className="flex-1 pr-3">
                  <div className="text-xs font-medium text-cafe-black">{v.name}</div>
                  <div className="text-[10px] text-cafe-secondary">{v.description}</div>
                </div>
                {isBinary ? (
                  <button
                    type="button"
                    disabled={isUpdating}
                    onClick={() => toggleEnvVar(v.name, v.currentValue)}
                    className={`relative h-5 w-9 rounded-full transition-colors ${isOn ? 'bg-green-500' : 'bg-gray-300'} ${isUpdating ? 'opacity-50' : ''}`}
                  >
                    <span
                      className={`absolute top-0.5 left-0.5 h-4 w-4 rounded-full bg-white shadow transition-transform ${isOn ? 'translate-x-4' : ''}`}
                    />
                  </button>
                ) : (
                  <span className="rounded bg-amber-100 px-1.5 py-0.5 text-[10px] font-medium text-amber-700">
                    {v.currentValue}
                  </span>
                )}
              </div>
            );
          })}
        </div>
      )}

      {/* Config reference — all non-toggle evidence env vars */}
      {configVars.length > 0 && (
        <div className="rounded-lg border border-cafe bg-white p-3">
          <h3 className="mb-2 text-xs font-semibold text-cafe-black">配置参考</h3>
          <p className="mb-2 text-[10px] text-cafe-secondary">以下配置需在 .env 中设置，修改后重启生效。</p>
          {configVars.map((v) => (
            <div key={v.name} className="border-b border-cafe/50 py-2 last:border-b-0">
              <div className="flex items-center justify-between">
                <span className="text-xs font-medium font-mono text-cafe-black">{v.name}</span>
                <span className="text-[10px] font-mono text-cafe-secondary truncate max-w-[50%] text-right">
                  {v.sensitive ? '••••••' : v.currentValue || v.defaultValue}
                </span>
              </div>
              <div className="text-[10px] text-cafe-secondary mt-0.5">{v.description}</div>
            </div>
          ))}
        </div>
      )}

      {/* Refresh button */}
      <button
        type="button"
        onClick={fetchAll}
        className="rounded-lg border border-cafe bg-white px-3 py-1.5 text-xs text-cafe-secondary transition-colors hover:bg-cafe-surface"
      >
        刷新状态
      </button>
    </div>
  );
}
