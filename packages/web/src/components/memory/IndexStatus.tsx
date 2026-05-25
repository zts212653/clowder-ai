'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { apiFetch } from '@/utils/api-client';
import { RebuildButton } from './RebuildButton';

interface RawStatusResponse {
  backend: string;
  healthy: boolean;
  docs_count?: number;
  threads_count?: number;
  passages_count?: number;
  passage_vectors_count?: number;
  passage_vectors_supported?: boolean;
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
  passageVectorsCount: number;
  passageVectorsSupported: boolean;
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
    passageVectorsCount: raw.passage_vectors_count ?? 0,
    passageVectorsSupported: raw.passage_vectors_supported ?? false,
    edgesCount: raw.edges_count ?? 0,
    lastRebuildAt: raw.last_rebuild_at ?? null,
    embeddingModel: raw.embedding_model ?? null,
    reason: raw.reason,
  };
}

/**
 * F209 Pure: is passage-vector embedding still warming up in the background?
 * True only when passage vectors are SUPPORTED (sqlite-vec available / embedding on) and there
 * are passages whose vectors are not all computed yet. When unsupported (embed off / no vec table),
 * the count stays 0 forever — this guard prevents a perpetual "warming up" banner + 3s poll loop.
 */
export function isEmbeddingWarmingUp(status: IndexStatusData): boolean {
  return (
    status.passageVectorsSupported && status.passagesCount > 0 && status.passageVectorsCount < status.passagesCount
  );
}

// ── F188 Phase A: Rebuild job types + parser ──

interface RawRebuildJob {
  id: string;
  status: string;
  phase: string;
  percent: number;
  error?: string;
  result?: { docsIndexed: number; docsSkipped: number; durationMs: number };
  startedAt: number;
  completedAt?: number;
}

export interface RebuildJobData {
  id: string;
  status: 'pending' | 'running' | 'done' | 'error';
  phase: string;
  percent: number;
  error?: string;
  result?: { docsIndexed: number; docsSkipped: number; durationMs: number };
  startedAt: number;
  completedAt?: number;
}

export function parseRebuildJob(raw: RawRebuildJob): RebuildJobData {
  return {
    id: raw.id,
    status: raw.status as RebuildJobData['status'],
    phase: raw.phase,
    percent: raw.percent,
    error: raw.error,
    result: raw.result,
    startedAt: raw.startedAt,
    completedAt: raw.completedAt,
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
  allowedValues?: string[];
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
    <div className="flex items-center justify-between rounded-lg px-2 py-2">
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
      setError('获取记忆状态失败');
    }
  }, []);

  const cycleEnvVar = useCallback(
    async (name: string, currentValue: string | null, allowedValues?: string[]) => {
      setUpdatingKey(name);
      let newValue: string;
      if (allowedValues && allowedValues.length > 1) {
        const idx = allowedValues.indexOf(currentValue ?? allowedValues[0]!);
        newValue = allowedValues[(idx + 1) % allowedValues.length]!;
      } else {
        newValue = currentValue === 'on' ? 'off' : 'on';
      }
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

  // F209: while passage vectors are warming up in the background, poll so the
  // progress count climbs live. Stops automatically once fully embedded.
  const warmingUp = status ? isEmbeddingWarmingUp(status) : false;
  useEffect(() => {
    if (!warmingUp) return;
    const timer = setInterval(fetchAll, 3000);
    return () => clearInterval(timer);
  }, [warmingUp, fetchAll]);

  if (error) {
    return (
      <div data-testid="index-status" className="rounded-lg border border-conn-red-ring bg-conn-red-bg p-4">
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
        <p className="text-sm text-cafe-secondary">加载中...</p>
      </div>
    );
  }

  return (
    <div data-testid="index-status" className="space-y-4">
      {/* Health badge */}
      <div className="flex items-center gap-2">
        <span
          className={`inline-block h-2.5 w-2.5 rounded-full ${status.healthy ? 'bg-conn-green-text' : 'bg-conn-red-text'}`}
        />
        <span className="text-sm font-medium text-cafe-black">{status.healthy ? '健康' : '异常'}</span>
        {status.reason && <span className="text-xs text-cafe-secondary">({status.reason})</span>}
      </div>

      {/* F209: background embedding warm-up banner (auto-hides once fully embedded) */}
      {warmingUp && (
        <div data-testid="embedding-warmup" className="rounded-lg border border-conn-amber-ring bg-conn-amber-bg p-3">
          <div className="flex items-center justify-between">
            <span className="text-xs font-medium text-conn-amber-text">语义索引暖机中…</span>
            <span className="text-xs font-mono text-conn-amber-text">
              {status.passageVectorsCount} / {status.passagesCount}
            </span>
          </div>
          <div className="mt-2 h-1.5 w-full overflow-hidden rounded-full bg-[var(--console-field-bg)]">
            <div
              className="h-full rounded-full bg-conn-amber-text transition-[width] duration-500"
              style={{
                width: `${Math.min(100, Math.round((status.passageVectorsCount / status.passagesCount) * 100))}%`,
              }}
            />
          </div>
          <p className="mt-1.5 text-micro text-cafe-secondary">
            关键词检索已就绪；语义召回在后台补全，完成前部分历史暂未覆盖。
          </p>
        </div>
      )}

      {/* Stats */}
      <div className="rounded-lg bg-[var(--console-card-bg)] p-3">
        <StatusRow label="后端" value={status.backend} />
        <StatusRow label="文档" value={status.docsCount} />
        <StatusRow label="线程" value={status.threadsCount} />
        <StatusRow label="段落" value={status.passagesCount} />
        <StatusRow
          label="段落向量"
          value={warmingUp ? `${status.passageVectorsCount} / ${status.passagesCount}` : status.passageVectorsCount}
        />
        <StatusRow label="关系边" value={status.edgesCount} />
        {status.embeddingModel && <StatusRow label="嵌入模型" value={status.embeddingModel} />}
        <StatusRow
          label="上次重建"
          value={status.lastRebuildAt ? new Date(status.lastRebuildAt).toLocaleString() : '从未'}
        />
      </div>

      {/* Feature flags */}
      {evidenceVars.length > 0 && (
        <div className="rounded-lg bg-[var(--console-card-bg)] p-3">
          <h3 className="mb-2 text-xs font-semibold text-cafe-black">功能开关</h3>
          {evidenceVars.map((v) => {
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
                {hasMultiValues ? (
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
                ) : (
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
                )}
              </div>
            );
          })}
        </div>
      )}

      {/* Config reference — all non-toggle evidence env vars */}
      {configVars.length > 0 && (
        <div className="rounded-lg bg-[var(--console-card-bg)] p-3">
          <h3 className="mb-2 text-xs font-semibold text-cafe-black">配置参考</h3>
          <p className="mb-2 text-micro text-cafe-secondary">以下配置需在 .env 中设置，修改后重启生效。</p>
          {configVars.map((v) => (
            <div key={v.name} className="rounded-lg px-2 py-2">
              <div className="flex items-center justify-between">
                <span className="text-xs font-medium font-mono text-cafe-black">{v.name}</span>
                <span className="text-micro font-mono text-cafe-secondary truncate max-w-[50%] text-right">
                  {v.sensitive ? '••••••' : v.currentValue || v.defaultValue}
                </span>
              </div>
              <div className="text-micro text-cafe-secondary mt-0.5">{v.description}</div>
            </div>
          ))}
        </div>
      )}

      {/* F188: Rebuild + Refresh buttons */}
      <div className="flex gap-2">
        <RebuildButton onComplete={fetchAll} />
        <button
          type="button"
          onClick={fetchAll}
          className="rounded-lg bg-cafe-accent px-3 py-1.5 text-xs font-semibold text-[var(--cafe-surface)] transition-colors hover:bg-cafe-accent-hover"
        >
          刷新状态
        </button>
      </div>
    </div>
  );
}
