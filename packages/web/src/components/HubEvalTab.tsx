'use client';

import { useCallback, useEffect, useState } from 'react';
import { useCatNameResolver } from '@/hooks/useCatNameResolver';
import { apiFetch } from '@/utils/api-client';
import { type EvalHubItem, VERDICT_LABELS } from './HubEvalTypes';
import { HubEvalVerdictCard } from './HubEvalVerdictCard';

export { VERDICT_LABELS };

interface EvalDomainSummary {
  domainId: string;
  displayName: string;
  systemThreadId: string;
  frequency: string;
  evalCatId: string;
  evalCatHandle: string;
  /**
   * Sunset state. When false, domain.yaml has `enabled: false` — scheduled cron
   * skips it and `nextCronFireAt` is omitted. UI shows a "Sunset" indicator
   * instead of "下次评估" so operators don't see a misleading future fire time.
   */
  enabled: boolean;
  hasVerdict: boolean;
  latestVerdictId?: string;
  latestVerdict?: EvalHubItem['verdict'];
  /** Next cron fire time. Omitted when `enabled === false` (sunset). */
  nextCronFireAt?: string;
}

interface EvalHubSummary {
  counts: {
    total: number;
    actionable: number;
    keepObserve: number;
    stale: number;
    registeredDomains?: number;
  };
  domains?: EvalDomainSummary[];
  items: EvalHubItem[];
}

export function HubEvalTab() {
  const [summary, setSummary] = useState<EvalHubSummary | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const fetchSummary = useCallback(async () => {
    try {
      setError(null);
      const response = await apiFetch('/api/eval-hub/summary');
      if (!response.ok) {
        throw new Error(`Eval Hub summary failed (${response.status})`);
      }
      setSummary((await response.json()) as EvalHubSummary);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void fetchSummary();
  }, [fetchSummary]);

  if (loading) return <p className="text-sm text-cafe-muted">...</p>;
  if (error) {
    return (
      <div className="rounded-lg bg-cafe-surface-elevated p-4 text-sm text-conn-red-text" role="alert">
        Eval Hub 暂时不可用：{error}
      </div>
    );
  }
  if (!summary || (summary.items.length === 0 && (!summary.domains || summary.domains.length === 0))) {
    return (
      <div className="rounded-lg bg-cafe-surface-elevated p-4 text-sm text-cafe-secondary">
        还没有 live verdict。Eval Hub 只展示已经提交证据包的真实 eval 结论。
      </div>
    );
  }

  return (
    <div className="space-y-4" data-guide-id="observability.eval-panel">
      <p className="text-xs text-cafe-muted">
        Harness Eval 控制面板：猫猫定期评估自身协作机制的健康度，下方是最新评估结论。
      </p>
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <StatCell label="评估结论" sublabel="总数" value={summary.counts.total} />
        <StatCell label="需处理" sublabel="build/fix/delete" value={summary.counts.actionable} />
        <StatCell label="持续观察" sublabel="暂无异常" value={summary.counts.keepObserve} />
        <StatCell label="过期" sublabel="需重新评估" value={summary.counts.stale} />
      </div>

      {summary.domains && summary.domains.length > 0 && (
        <div className="space-y-3">
          <h2 className="text-sm font-semibold text-cafe">评估域总览</h2>
          {summary.domains.map((domain) => (
            <DomainCard key={domain.domainId} domain={domain} onCatUpdated={fetchSummary} />
          ))}
        </div>
      )}

      {summary.items.length === 0 && (
        <div className="rounded-lg bg-cafe-surface-elevated p-4 text-sm text-cafe-secondary">
          还没有 live verdict。Eval Hub 只展示已经提交证据包的真实 eval 结论。
        </div>
      )}

      {summary.items.length > 0 && (
        <div className="space-y-3">
          {summary.items.map((item) => (
            <HubEvalVerdictCard key={item.id} item={item} />
          ))}
        </div>
      )}
    </div>
  );
}

function StatCell({ label, sublabel, value }: { label: string; sublabel?: string; value: number }) {
  return (
    <div className="rounded-lg bg-cafe-surface-elevated px-4 py-3">
      <div className="text-xs text-cafe-muted">{label}</div>
      {sublabel && <div className="text-micro text-cafe-muted/60">{sublabel}</div>}
      <div className="mt-1 text-xl font-semibold text-cafe">{value}</div>
    </div>
  );
}

function DomainCard({ domain, onCatUpdated }: { domain: EvalDomainSummary; onCatUpdated?: () => void }) {
  const resolveCatName = useCatNameResolver();
  const [editing, setEditing] = useState(false);
  const [catId, setCatId] = useState(domain.evalCatId);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [availableCats, setAvailableCats] = useState<Array<{ catId: string; handle: string; family: string }>>([]);

  const startEditing = useCallback(async () => {
    setEditing(true);
    try {
      const res = await apiFetch('/api/eval-hub/available-cats');
      if (res.ok) {
        const data = (await res.json()) as { cats: Array<{ catId: string; handle: string; family: string }> };
        setAvailableCats(data.cats);
      }
    } catch {
      /* best-effort roster load */
    }
  }, []);

  const handleSave = useCallback(async () => {
    if (!catId.trim()) return;
    setSaving(true);
    setError(null);
    try {
      const res = await apiFetch(`/api/eval-domains/${encodeURIComponent(domain.domainId)}/eval-cat`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ catId: catId.trim() }),
      });
      if (!res.ok) {
        const body = (await res.json()) as { error?: string };
        throw new Error(body.error ?? `Save failed (${res.status})`);
      }
      setEditing(false);
      onCatUpdated?.();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  }, [catId, domain.domainId, onCatUpdated]);

  return (
    <section className="rounded-lg bg-cafe-surface-elevated p-4">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0">
          <div className="text-xs font-medium uppercase tracking-wide text-cafe-muted">{domain.domainId}</div>
          <h3 className="mt-1 text-base font-semibold text-cafe">{domain.displayName}</h3>
          <p className="mt-1 text-xs text-cafe-muted">
            评估频率: {domain.frequency} · 评估猫:{' '}
            {editing ? (
              <span className="inline-flex items-center gap-1">
                {availableCats.length > 0 ? (
                  <select
                    value={catId}
                    onChange={(e) => setCatId(e.target.value)}
                    className="w-36 rounded border border-cafe bg-cafe-surface px-1.5 py-0.5 text-xs text-cafe"
                  >
                    {availableCats.map((cat) => (
                      <option key={cat.catId} value={cat.catId}>
                        {resolveCatName(cat.catId)}
                      </option>
                    ))}
                  </select>
                ) : (
                  <input
                    type="text"
                    value={catId}
                    onChange={(e) => setCatId(e.target.value)}
                    className="w-28 rounded border border-cafe bg-cafe-surface px-1.5 py-0.5 text-xs text-cafe"
                    placeholder="catId"
                  />
                )}
                <button
                  type="button"
                  onClick={handleSave}
                  disabled={saving}
                  className="rounded bg-[var(--console-button-emphasis)] px-2 py-0.5 text-xs text-white hover:opacity-90 disabled:opacity-50"
                >
                  {saving ? '...' : '保存'}
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setEditing(false);
                    setCatId(domain.evalCatId);
                    setError(null);
                  }}
                  className="text-xs text-cafe-muted hover:text-cafe"
                >
                  取消
                </button>
              </span>
            ) : (
              <span>
                {domain.evalCatId ? resolveCatName(domain.evalCatId) : domain.evalCatHandle}{' '}
                <button
                  type="button"
                  onClick={startEditing}
                  className="text-xs text-cafe-muted hover:text-cafe"
                  title="编辑评估猫"
                >
                  ✏️
                </button>
              </span>
            )}
          </p>
          {error && <p className="mt-1 text-xs text-conn-red-text">{error}</p>}
          {(() => {
            const line = deriveDomainScheduleLine(domain);
            if (line.kind === 'sunset') {
              return (
                <p className="mt-0.5 text-xs text-cafe-muted" title="Sunset — domain.yaml has enabled: false">
                  {line.text}
                </p>
              );
            }
            if (line.kind === 'next-eval') {
              return <p className="mt-0.5 text-xs text-cafe-muted">{line.text}</p>;
            }
            return null;
          })()}
        </div>
        <span className="inline-flex shrink-0 rounded-md bg-cafe-surface px-2.5 py-1 text-xs font-semibold text-[var(--console-button-emphasis)]">
          {deriveDomainStatusBadge(domain)}
        </span>
      </div>
      <div className="mt-3 flex flex-wrap gap-2">
        <a
          href={`/thread/${encodeURIComponent(domain.systemThreadId)}`}
          className="rounded-md border border-cafe px-3 py-1.5 text-xs font-medium text-cafe-secondary hover:text-cafe"
        >
          {domain.displayName} 工作线程
        </a>
        {domain.domainId === 'eval:memory' && (
          <a
            href="/memory/health"
            className="rounded-md border border-cafe px-3 py-1.5 text-xs font-medium text-cafe-secondary hover:text-cafe"
          >
            记忆健康
          </a>
        )}
      </div>
    </section>
  );
}

// ---- Sunset-rendering helpers (extracted for vitest unit coverage) ----
// Pattern follows evidence-search.test.ts: pull pure logic out of JSX so we
// can vitest it without bringing in @testing-library/react / jsdom. Closes
// gpt52 R2 residual test gap on sunset rendering branches.

export type DomainScheduleLine =
  | { kind: 'sunset'; text: string }
  | { kind: 'next-eval'; text: string }
  | { kind: 'none' };

/**
 * Decide the secondary line under the cat row in a domain card.
 * - Sunset (enabled=false): "🌙 Sunset · 自动调度已停" — never lie about a
 *   future cron fire (would mirror silent-fire on the operator surface).
 * - Active + has nextCronFireAt: "下次评估: <locale string>".
 * - Active + no nextCronFireAt: nothing (kind=none).
 */
export function deriveDomainScheduleLine(domain: {
  enabled: boolean;
  nextCronFireAt?: string;
  /** Used to distinguish N-day probe cadence from actual eval cadence (gpt52 R1 P2). */
  frequency?: string;
}): DomainScheduleLine {
  if (domain.enabled === false) {
    return { kind: 'sunset', text: '🌙 Sunset · 自动调度已停 (yaml: enabled: false)' };
  }
  if (domain.nextCronFireAt) {
    // N-day domains (every-Nd): cron fires daily but last-run gate controls actual eval.
    // Show "下次探测 (every-Nd)" instead of "下次评估" to avoid implying eval WILL run
    // at the next daily fire — the gate may skip it (gpt52 R1 P2 fix).
    const isNDay = domain.frequency ? /^every-\d+d$/.test(domain.frequency) : false;
    const label = isNDay ? `下次探测 (${domain.frequency})` : '下次评估';
    return {
      kind: 'next-eval',
      text: `${label}: ${new Date(domain.nextCronFireAt).toLocaleString()}`,
    };
  }
  return { kind: 'none' };
}

/**
 * Decide the verdict-status badge text in a domain card.
 * Sunset wins over verdict label / "待首次评估" — operators must see the
 * domain is paused, not a stale verdict status.
 */
export function deriveDomainStatusBadge(domain: {
  enabled: boolean;
  hasVerdict: boolean;
  latestVerdict?: EvalHubItem['verdict'];
}): string {
  if (domain.enabled === false) return 'Sunset';
  if (domain.hasVerdict && domain.latestVerdict) {
    return VERDICT_LABELS[domain.latestVerdict];
  }
  return '待首次评估';
}
