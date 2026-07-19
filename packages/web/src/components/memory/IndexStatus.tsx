'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { apiFetch } from '@/utils/api-client';
import { RebuildButton } from './RebuildButton';

// F188 Phase K: shared types for config-warning surface (AC-K1/K3/K4)
export type FunctionalStatus = 'ok' | 'degraded';

export type ConfigWarningCode =
  | 'docs_root_suspicious'
  | 'embedding_disabled'
  | 'vectors_empty'
  | 'graph_empty'
  | 'vec_table_missing';

export interface ConfigWarning {
  code: ConfigWarningCode;
  message: string;
  suggestedAction: string;
}

interface RawStatusResponse {
  backend: string;
  healthy: boolean;
  docs_count?: number;
  vectors_count?: number;
  threads_count?: number;
  passages_count?: number;
  passage_vectors_count?: number;
  passage_vectors_supported?: boolean;
  passage_warmup_active?: boolean;
  edges_count?: number;
  last_rebuild_at?: string | null;
  embedding_model?: string | null;
  reason?: string;
  // F188 Phase K extension
  functionalStatus?: FunctionalStatus;
  configWarnings?: ConfigWarning[];
}

export interface IndexStatusData {
  backend: string;
  healthy: boolean;
  docsCount: number;
  vectorsCount: number;
  threadsCount: number;
  passagesCount: number;
  passageVectorsCount: number;
  passageVectorsSupported: boolean;
  passageWarmupActive: boolean;
  edgesCount: number;
  lastRebuildAt: string | null;
  embeddingModel: string | null;
  reason?: string;
  // F188 Phase K — default `'ok'` + `[]` when API omits them (older backend).
  functionalStatus: FunctionalStatus;
  configWarnings: ConfigWarning[];
}

/**
 * Pure: parse raw API response into normalized status data.
 */
export function parseIndexStatus(raw: RawStatusResponse): IndexStatusData {
  return {
    backend: raw.backend,
    healthy: raw.healthy,
    docsCount: raw.docs_count ?? 0,
    vectorsCount: raw.vectors_count ?? 0,
    threadsCount: raw.threads_count ?? 0,
    passagesCount: raw.passages_count ?? 0,
    passageVectorsCount: raw.passage_vectors_count ?? 0,
    passageVectorsSupported: raw.passage_vectors_supported ?? false,
    passageWarmupActive: raw.passage_warmup_active ?? false,
    edgesCount: raw.edges_count ?? 0,
    lastRebuildAt: raw.last_rebuild_at ?? null,
    embeddingModel: raw.embedding_model ?? null,
    reason: raw.reason,
    functionalStatus: raw.functionalStatus ?? 'ok',
    configWarnings: raw.configWarnings ?? [],
  };
}

/**
 * F188 Phase K (AC-K4): pure predicate — does the degraded banner show?
 *
 * Rules:
 *   - healthy=false → caller renders the red fatal badge; we do NOT also
 *     show the yellow degraded banner (red takes precedence per plan KD-15)
 *   - functionalStatus='degraded' + at least one warning → show
 *   - everything else → hide
 */
export function shouldShowDegradedBanner(status: IndexStatusData): boolean {
  if (!status.healthy) return false;
  return status.functionalStatus === 'degraded' && status.configWarnings.length > 0;
}

/**
 * F188 Phase K (AC-K4): the actual degraded banner. Extracted so vitest can
 * render-test it without standing up the full IndexStatus + apiFetch chain.
 *
 * AC-K4 P1-1 (砚砚 review 2026-06-19): each warning's `suggestedAction`
 * renders as a real `<button>` (clickable next step), not a plain `<span>`.
 * The button fires `onWarningClick(code)` so the parent can scroll to the
 * relevant config section / focus a control / trigger a rebuild — keeping
 * action-routing logic in IndexStatus (where envVars + rebuild state live)
 * while the pure render stays testable here.
 */
export function DegradedBanner({
  warnings,
  onWarningClick,
}: {
  warnings: ConfigWarning[];
  onWarningClick?: (code: ConfigWarningCode) => void;
}) {
  return (
    <div data-testid="memory-degraded-banner" className="rounded-lg border border-conn-amber-ring bg-conn-amber-bg p-3">
      <div className="font-semibold text-sm text-conn-amber-text">记忆能力降级（Memory capabilities degraded）</div>
      <div className="mt-0.5 text-micro text-cafe-secondary">
        API 在运行，但检测到配置问题（API running but configuration issues detected）。
      </div>
      <ul className="mt-2 space-y-1.5">
        {warnings.map((w) => (
          <li
            key={w.code}
            data-testid={`memory-degraded-warning-${w.code}`}
            className="flex flex-col gap-0.5 rounded-md bg-[var(--console-field-bg)] px-2 py-1.5"
          >
            <span className="text-xs text-cafe-black">{w.message}</span>
            <button
              type="button"
              data-testid={`memory-degraded-action-${w.code}`}
              onClick={() => onWarningClick?.(w.code)}
              className="self-start rounded-sm text-micro font-medium text-conn-amber-text underline-offset-2 hover:underline focus:outline-none focus:ring-1 focus:ring-conn-amber-text"
            >
              → {w.suggestedAction}
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}

/**
 * F188 Phase K (AC-K4): map warning code → target section id in IndexStatus.
 * Used by `handleWarningClick` to scroll the right config surface into view.
 * Exposed for test reuse.
 */
export const WARNING_ACTION_TARGETS: Record<ConfigWarningCode, string> = {
  docs_root_suspicious: 'evidence-config-vars',
  embedding_disabled: 'embedding-service-controls',
  vectors_empty: 'rebuild-controls',
  graph_empty: 'rebuild-controls',
  vec_table_missing: 'embedding-service-controls',
};

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

export function IndexStatus({ refreshToken = 0 }: { refreshToken?: number }) {
  const [status, setStatus] = useState<IndexStatusData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [envVars, setEnvVars] = useState<EnvVar[]>([]);
  const [updatingKey, setUpdatingKey] = useState<string | null>(null);
  const [warmupTriggering, setWarmupTriggering] = useState(false);

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
  }, [fetchAll, refreshToken]);

  // AC-K4 P1-1 (砚砚 review 2026-06-19): when a degraded-banner action button
  // is clicked, scroll the relevant config section into view and pulse a focus
  // ring so the cat sees *where* the next step lives. Mapping in WARNING_ACTION_TARGETS.
  const handleWarningClick = useCallback((code: ConfigWarningCode) => {
    const targetId = WARNING_ACTION_TARGETS[code];
    if (!targetId) return;
    const el = document.getElementById(targetId);
    if (!el) return;
    el.scrollIntoView({ behavior: 'smooth', block: 'start' });
    el.classList.add('ring-2', 'ring-conn-amber-text');
    setTimeout(() => el.classList.remove('ring-2', 'ring-conn-amber-text'), 1500);
  }, []);

  const [warmupError, setWarmupError] = useState<string | null>(null);

  const triggerWarmup = useCallback(async () => {
    setWarmupTriggering(true);
    setWarmupError(null);
    try {
      const res = await apiFetch('/api/evidence/warmup', { method: 'POST' });
      if (!res.ok) {
        const body = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
        setWarmupError((body as { error?: string }).error ?? `HTTP ${res.status}`);
      }
      await fetchAll();
    } catch {
      setWarmupError('网络错误');
    } finally {
      setWarmupTriggering(false);
    }
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
      {/* F188 Phase K (AC-K4): config-health degraded banner (above health badge) */}
      {shouldShowDegradedBanner(status) && (
        <DegradedBanner warnings={status.configWarnings} onWarningClick={handleWarningClick} />
      )}

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
            <span
              className={`text-xs font-medium ${status.passageWarmupActive ? 'text-conn-green-text' : 'text-conn-amber-text'}`}
            >
              {status.passageWarmupActive ? '语义索引暖机中…' : '语义索引待暖机'}
            </span>
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
          <div className="mt-1.5 flex items-center justify-between">
            <p className="text-micro text-cafe-secondary">
              关键词检索已就绪；语义召回在后台补全，完成前部分历史暂未覆盖。
            </p>
            <span className="ml-auto flex items-center gap-1.5">
              {warmupError && (
                <span data-testid="warmup-error" className="text-micro text-red-500">
                  {warmupError}
                </span>
              )}
              <button
                type="button"
                data-testid="warmup-resume-button"
                disabled={warmupTriggering || status.passageWarmupActive}
                onClick={triggerWarmup}
                className={`shrink-0 rounded-md px-2.5 py-1 text-micro font-medium text-white transition-opacity hover:opacity-90 ${
                  status.passageWarmupActive ? 'bg-conn-green-text' : 'bg-conn-amber-text'
                } ${warmupTriggering || status.passageWarmupActive ? 'opacity-70' : ''}`}
              >
                {warmupTriggering ? '触发中…' : status.passageWarmupActive ? '暖机中…' : '继续暖机'}
              </button>
            </span>
          </div>
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
        <div id="evidence-feature-flags" className="rounded-lg bg-[var(--console-card-bg)] p-3 transition-shadow">
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
        <div id="evidence-config-vars" className="rounded-lg bg-[var(--console-card-bg)] p-3 transition-shadow">
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
      <div id="rebuild-controls" className="flex gap-2 rounded-lg p-1 transition-shadow">
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
