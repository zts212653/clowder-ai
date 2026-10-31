'use client';

import { type ReactNode, useCallback, useEffect, useState } from 'react';
import { useCatNameResolver } from '@/hooks/useCatNameResolver';
import { apiFetch } from '@/utils/api-client';
import { PawFeelSettingsSection } from './eval-settings/PawFeelSettingsSection';
import { useEvalCopy, useEvalLanguage } from './eval-workspace/eval-workspace.shell-copy';
import { HubEvalMetricGlossary } from './HubEvalMetricGlossary';
import {
  deriveDomainScheduleLine,
  deriveDomainStateBadge,
  deriveDomainVerdictLabel,
  type EvalDomainSummary,
  type EvalHubSummary,
  VERDICT_LABELS,
} from './HubEvalTypes';
import { HubEvalVerdictCard } from './HubEvalVerdictCard';

export { VERDICT_LABELS };

export function HubEvalTab() {
  const t = useEvalCopy();
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

  let periodicSurface: ReactNode;
  if (loading) {
    periodicSurface = <p className="text-sm text-cafe-muted">{t.loading}</p>;
  } else if (error) {
    periodicSurface = (
      <div className="rounded-lg bg-cafe-surface-elevated p-4 text-sm text-conn-red-text" role="alert">
        {t.hubUnavailable}: {error}
      </div>
    );
  } else if (!summary || (summary.items.length === 0 && summary.domains.length === 0)) {
    periodicSurface = (
      <div className="rounded-lg bg-cafe-surface-elevated p-4 text-sm text-cafe-secondary">{t.noSummary}</div>
    );
  } else {
    periodicSurface = <PeriodicEvalSurface summary={summary} onCatUpdated={fetchSummary} />;
  }

  return (
    <div className="space-y-4" data-guide-id="observability.eval-panel">
      <PawFeelSettingsSection />
      {periodicSurface}
    </div>
  );
}

/** Original periodic ledger content, also used by the Workspace owner with the same summary and refresh authority. */
export function PeriodicEvalSurface({ summary, onCatUpdated }: { summary: EvalHubSummary; onCatUpdated: () => void }) {
  const t = useEvalCopy();
  return (
    <>
      <p className="text-xs text-cafe-muted">{t.periodicDescription}</p>
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <StatCell label={t.verdictCount} sublabel={t.total} value={summary.counts.total} />
        <StatCell label={t.actionable} sublabel="build/fix/delete" value={summary.counts.actionable} />
        <StatCell label={t.keepObserve} sublabel={t.noAnomaly} value={summary.counts.keepObserve} />
        <StatCell label={t.stale} sublabel={t.needsReeval} value={summary.counts.stale} />
      </div>

      {summary.domains.length > 0 && (
        <div className="space-y-3">
          <h2 className="text-sm font-semibold text-cafe">{t.domains}</h2>
          {summary.domains.map((domain) => (
            <DomainCard key={domain.domainId} domain={domain} onCatUpdated={onCatUpdated} />
          ))}
        </div>
      )}

      {summary.items.length === 0 && (
        <div className="rounded-lg bg-cafe-surface-elevated p-4 text-sm text-cafe-secondary">{t.noSummary}</div>
      )}

      {summary.items.length > 0 && (
        <div className="space-y-3">
          {summary.items.map((item) => (
            <HubEvalVerdictCard
              key={item.id}
              item={item}
              metricGlossary={summary.domains.find((domain) => domain.domainId === item.domainId)?.metricGlossary}
              projectPath={summary.repoProjectPath}
              worktreeId={summary.repoWorktreeId}
            />
          ))}
        </div>
      )}
    </>
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
  const t = useEvalCopy();
  const language = useEvalLanguage();
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
          {domain.descriptionForHuman ? (
            <p className="mt-1 text-xs leading-relaxed text-cafe-secondary">{domain.descriptionForHuman}</p>
          ) : null}
          <p className="mt-1 text-xs text-cafe-muted">
            {t.frequency}: {domain.frequency} · {t.evalCat}:{' '}
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
                  className="rounded bg-[var(--console-button-emphasis)] px-2 py-0.5 text-xs text-[var(--cafe-surface)] hover:opacity-90 disabled:opacity-50"
                >
                  {saving ? '...' : t.save}
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
                  {t.cancel}
                </button>
              </span>
            ) : (
              <span>
                {domain.evalCatId ? resolveCatName(domain.evalCatId) : domain.evalCatHandle}{' '}
                <button
                  type="button"
                  onClick={startEditing}
                  className="text-xs text-cafe-muted hover:text-cafe"
                  title={t.editCat}
                >
                  ✏️
                </button>
              </span>
            )}
          </p>
          {error && <p className="mt-1 text-xs text-conn-red-text">{error}</p>}
          {(() => {
            const line = deriveDomainScheduleLine(domain, language);
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
          <HubEvalMetricGlossary glossary={domain.metricGlossary} />
        </div>
        <div className="flex shrink-0 flex-col items-end gap-1">
          <span className="inline-flex rounded-md bg-cafe-surface px-2.5 py-1 text-xs font-semibold text-[var(--console-button-emphasis)]">
            {deriveDomainStateBadge(domain, language)}
          </span>
          {(() => {
            const label = deriveDomainVerdictLabel(domain, language);
            if (!label) return null;
            return (
              <span className="inline-flex rounded-md border border-cafe bg-cafe-surface px-2.5 py-0.5 text-xs font-medium text-cafe-secondary">
                {t.verdict}: {label}
              </span>
            );
          })()}
        </div>
      </div>
      <div className="mt-3 flex flex-wrap gap-2">
        <a
          href={`/thread/${encodeURIComponent(domain.systemThreadId)}`}
          className="rounded-md border border-cafe px-3 py-1.5 text-xs font-medium text-cafe-secondary hover:text-cafe"
        >
          {domain.displayName} · {t.workThread}
        </a>
        {domain.domainId === 'eval:memory' && (
          <a
            href="/memory/health"
            className="rounded-md border border-cafe px-3 py-1.5 text-xs font-medium text-cafe-secondary hover:text-cafe"
          >
            {t.memoryHealth}
          </a>
        )}
      </div>
    </section>
  );
}
