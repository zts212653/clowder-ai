'use client';

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useShellPresentation } from '@/components/shell/shell-presentation';
import { apiFetch } from '@/utils/api-client';
import { PawFeelSettingsSection } from '../eval-settings/PawFeelSettingsSection';
import { HubEvalMetricGlossary } from '../HubEvalMetricGlossary';
import { PeriodicEvalSurface } from '../HubEvalTab';
import type { EvalHubSummary } from '../HubEvalTypes';
import { EvalWorkspaceEventCard } from './EvalWorkspaceEventCard';
import { useEvalCopy, useEvalLanguage } from './eval-workspace.shell-copy';
import { deriveEvalWorkspaceEvents, type EvalWorkspaceEvent } from './evalWorkspaceEvents';
import { PawFeelInboxSection } from './PawFeelInboxSection';

export function EvalWorkspacePanel() {
  const shellV2 = useShellPresentation() === 'v2';
  const t = useEvalCopy();
  const [ledger, setLedger] = useState(false);
  const [ledgerVisited, setLedgerVisited] = useState(false);
  const showLedger = shellV2 && ledger;
  const panelRef = useRef<HTMLDivElement>(null);
  const readingPositions = useRef({ events: 0, ledger: 0 });
  const switchView = () => {
    readingPositions.current[ledger ? 'ledger' : 'events'] = panelRef.current?.scrollTop ?? 0;
    setLedgerVisited(true);
    setLedger(!ledger);
  };
  useLayoutEffect(() => {
    if (panelRef.current) panelRef.current.scrollTop = readingPositions.current[ledger ? 'ledger' : 'events'];
  }, [ledger]);
  const [summary, setSummary] = useState<EvalHubSummary | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const fetchSummary = useCallback(async () => {
    try {
      setError(null);
      const response = await apiFetch('/api/eval-hub/summary');
      if (!response.ok) throw new Error(`Eval Hub summary failed (${response.status})`);
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

  const events = useMemo(() => (summary ? deriveEvalWorkspaceEvents(summary) : []), [summary]);
  const actionableEvents = events.filter((event) => event.kind !== 'watching' && event.kind !== 'resolved');
  const settledEvents = events.filter((event) => event.kind === 'watching' || event.kind === 'resolved');

  if (loading) {
    return (
      <div className="flex-1 min-h-0 overflow-y-auto p-4" data-testid="eval-workspace-panel">
        <PawFeelInboxSection />
        <div className="mt-4 text-sm text-cafe-muted">{t.loading}</div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex-1 p-4" data-testid="eval-workspace-panel">
        <PawFeelInboxSection />
        <div className="rounded-lg bg-conn-red-bg/80 p-3 text-sm text-conn-red-text" role="alert">
          {t.unavailable}: {error}
        </div>
      </div>
    );
  }

  if (!summary) {
    return (
      <div className="flex-1 p-4 text-sm text-cafe-secondary" data-testid="eval-workspace-panel">
        <PawFeelInboxSection />
        {t.noData}
      </div>
    );
  }

  return (
    <div
      ref={panelRef}
      className="flex-1 min-h-0 overflow-y-auto p-4"
      data-testid="eval-workspace-panel"
      data-eval-workspace-scroll
      data-trajectory-origin-scroll
    >
      <div className="flex items-start justify-between gap-3">
        <div>
          <h2 className="text-base font-semibold text-cafe">{shellV2 ? t.title : '评估'}</h2>
          <p className="mt-1 text-xs leading-relaxed text-cafe-secondary">
            {shellV2 ? t.description : '日常只放需要关注的 eval 事件；完整域字典、指标说明和历史记录仍在台账里。'}
          </p>
        </div>
        {shellV2 ? (
          <button
            type="button"
            data-testid="eval-open-ledger"
            aria-expanded={ledger}
            aria-controls="eval-workspace-ledger"
            onClick={switchView}
            className="shell-focusable shrink-0 rounded-md border border-cafe px-3 py-1.5 text-xs font-medium text-cafe-secondary hover:text-cafe"
          >
            {ledger ? t.backToEvents : t.openLedger}
          </button>
        ) : (
          <a
            href="/settings?ops=observability&obs=eval"
            className="shrink-0 rounded-md border border-cafe px-3 py-1.5 text-xs font-medium text-cafe-secondary hover:text-cafe"
          >
            查看台账
          </a>
        )}
      </div>

      <div
        id="eval-workspace-ledger"
        data-testid="eval-workspace-ledger"
        hidden={!showLedger}
        className="mt-4 space-y-4"
      >
        {ledgerVisited && (
          <>
            <PawFeelSettingsSection />
            <PeriodicEvalSurface summary={summary} onCatUpdated={fetchSummary} />
          </>
        )}
      </div>
      <div hidden={showLedger}>
        <div className="mt-4 grid grid-cols-3 gap-2">
          <StatCell label={t.needsAttention} value={actionableEvents.length} />
          <StatCell label={t.settledCount} value={settledEvents.length} />
          <StatCell label={t.stale} value={summary.counts.stale} />
        </div>

        <PawFeelInboxSection />

        {actionableEvents.length > 0 ? (
          <section className="mt-4 space-y-3" aria-label={t.attentionSection}>
            {actionableEvents.map((event) => (
              <EvalWorkspaceEventCard
                key={event.id}
                event={event}
                projectPath={summary.repoProjectPath}
                worktreeId={summary.repoWorktreeId}
                onOpenLedger={shellV2 ? switchView : undefined}
              />
            ))}
          </section>
        ) : (
          <QuietState
            events={settledEvents}
            generatedAt={summary.generatedAt}
            projectPath={summary.repoProjectPath}
            worktreeId={summary.repoWorktreeId}
            onOpenLedger={shellV2 ? switchView : undefined}
          />
        )}

        {actionableEvents.length > 0 && settledEvents.length > 0 ? (
          <section className="mt-5">
            <h3 className="text-sm font-semibold text-cafe">
              {settledEvents.some((event) => event.kind === 'resolved') ? t.settledHeading : t.observingHeading}
            </h3>
            <div className="mt-2 space-y-2">
              <SettledEventList
                events={settledEvents.slice(0, 3)}
                projectPath={summary.repoProjectPath}
                worktreeId={summary.repoWorktreeId}
                onOpenLedger={shellV2 ? switchView : undefined}
              />
            </div>
          </section>
        ) : null}
      </div>
    </div>
  );
}

function StatCell({ label, value }: { label: string; value: number }) {
  return (
    <div className="rounded-md bg-cafe-surface px-3 py-2">
      <div className="text-micro text-cafe-muted">{label}</div>
      <div className="mt-0.5 text-lg font-semibold text-cafe">{value}</div>
    </div>
  );
}

function QuietState({
  events,
  generatedAt,
  projectPath,
  worktreeId,
  onOpenLedger,
}: {
  events: EvalWorkspaceEvent[];
  generatedAt?: string;
  projectPath?: string;
  worktreeId?: string;
  onOpenLedger?: () => void;
}) {
  const t = useEvalCopy();
  const language = useEvalLanguage();
  return (
    <section className="mt-4">
      <div className="rounded-lg border border-cafe bg-cafe-surface px-4 py-3">
        <h3 className="text-sm font-semibold text-cafe">{t.quietTitle}</h3>
        <p className="mt-1 text-sm leading-relaxed text-cafe-secondary">
          {t.quietDescription}
          {generatedAt ? ` ${t.lastUpdated}: ${formatDate(generatedAt, language)}` : ''}
        </p>
      </div>
      {events.length > 0 ? (
        <div className="mt-4">
          <h3 className="text-sm font-semibold text-cafe">
            {events.some((event) => event.kind === 'resolved') ? t.settledHeading : t.observingHeading}
          </h3>
          <div className="mt-2 space-y-2">
            <SettledEventList
              events={events.slice(0, 4)}
              projectPath={projectPath}
              worktreeId={worktreeId}
              onOpenLedger={onOpenLedger}
            />
          </div>
        </div>
      ) : null}
    </section>
  );
}

function SettledEventList({
  events,
  projectPath,
  worktreeId,
  onOpenLedger,
}: {
  events: EvalWorkspaceEvent[];
  projectPath?: string;
  worktreeId?: string;
  onOpenLedger?: () => void;
}) {
  return events.map((event) =>
    event.kind === 'resolved' ? (
      <EvalWorkspaceEventCard
        key={event.id}
        event={event}
        projectPath={projectPath}
        worktreeId={worktreeId}
        onOpenLedger={onOpenLedger}
      />
    ) : (
      <WatchingLine key={event.id} event={event} />
    ),
  );
}

function WatchingLine({ event }: { event: EvalWorkspaceEvent }) {
  return (
    <div className="rounded-md bg-cafe-surface px-3 py-2">
      <div className="text-xs font-medium text-cafe">{event.domainDisplayName}</div>
      <p className="mt-1 text-xs leading-relaxed text-cafe-secondary">{event.summary}</p>
      <HubEvalMetricGlossary glossary={event.metricGlossary} />
    </div>
  );
}

function formatDate(value: string, language: 'zh' | 'en'): string {
  return new Intl.DateTimeFormat(language === 'en' ? 'en-US' : 'zh-CN', {
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(new Date(value));
}
