'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { apiFetch } from '@/utils/api-client';
import { HubEvalMetricGlossary } from '../HubEvalMetricGlossary';
import type { EvalHubSummary } from '../HubEvalTypes';
import { EvalWorkspaceEventCard } from './EvalWorkspaceEventCard';
import { deriveEvalWorkspaceEvents, type EvalWorkspaceEvent } from './evalWorkspaceEvents';
import { PawFeelInboxSection } from './PawFeelInboxSection';

const SETTINGS_EVAL_HUB_HREF = '/settings?ops=observability&obs=eval';

export function EvalWorkspacePanel() {
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
        <div className="mt-4 text-sm text-cafe-muted">加载周期评估事件...</div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex-1 p-4" data-testid="eval-workspace-panel">
        <PawFeelInboxSection />
        <div className="rounded-lg bg-conn-red-bg/80 p-3 text-sm text-conn-red-text" role="alert">
          周期 Eval 暂时不可用：{error}
        </div>
      </div>
    );
  }

  if (!summary) {
    return (
      <div className="flex-1 p-4 text-sm text-cafe-secondary" data-testid="eval-workspace-panel">
        <PawFeelInboxSection />
        暂无评估数据。
      </div>
    );
  }

  return (
    <div className="flex-1 min-h-0 overflow-y-auto p-4" data-testid="eval-workspace-panel">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h2 className="text-base font-semibold text-cafe">评估</h2>
          <p className="mt-1 text-xs leading-relaxed text-cafe-secondary">
            日常只放需要关注的 eval 事件；完整域字典、指标说明和历史记录仍在台账里。
          </p>
        </div>
        <a
          href={SETTINGS_EVAL_HUB_HREF}
          className="shrink-0 rounded-md border border-cafe px-3 py-1.5 text-xs font-medium text-cafe-secondary hover:text-cafe"
        >
          查看台账
        </a>
      </div>

      <div className="mt-4 grid grid-cols-3 gap-2">
        <StatCell label="需关注" value={actionableEvents.length} />
        <StatCell label="闭环 / 观察" value={settledEvents.length} />
        <StatCell label="过期" value={summary.counts.stale} />
      </div>

      <PawFeelInboxSection />

      {actionableEvents.length > 0 ? (
        <section className="mt-4 space-y-3" aria-label="需要关注的评估事件">
          {actionableEvents.map((event) => (
            <EvalWorkspaceEventCard
              key={event.id}
              event={event}
              projectPath={summary.repoProjectPath}
              worktreeId={summary.repoWorktreeId}
            />
          ))}
        </section>
      ) : (
        <QuietState
          events={settledEvents}
          generatedAt={summary.generatedAt}
          projectPath={summary.repoProjectPath}
          worktreeId={summary.repoWorktreeId}
        />
      )}

      {actionableEvents.length > 0 && settledEvents.length > 0 ? (
        <section className="mt-5">
          <h3 className="text-sm font-semibold text-cafe">{settledHeading(settledEvents)}</h3>
          <div className="mt-2 space-y-2">
            <SettledEventList
              events={settledEvents.slice(0, 3)}
              projectPath={summary.repoProjectPath}
              worktreeId={summary.repoWorktreeId}
            />
          </div>
        </section>
      ) : null}
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
}: {
  events: EvalWorkspaceEvent[];
  generatedAt?: string;
  projectPath?: string;
  worktreeId?: string;
}) {
  return (
    <section className="mt-4">
      <div className="rounded-lg border border-cafe bg-cafe-surface px-4 py-3">
        <h3 className="text-sm font-semibold text-cafe">暂无需要处理的评估事件</h3>
        <p className="mt-1 text-sm leading-relaxed text-cafe-secondary">
          最近的 eval 仍在守护；没有行动项不等于没有检查。{generatedAt ? `最后更新：${formatDate(generatedAt)}。` : ''}
        </p>
      </div>
      {events.length > 0 ? (
        <div className="mt-4">
          <h3 className="text-sm font-semibold text-cafe">{settledHeading(events)}</h3>
          <div className="mt-2 space-y-2">
            <SettledEventList events={events.slice(0, 4)} projectPath={projectPath} worktreeId={worktreeId} />
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
}: {
  events: EvalWorkspaceEvent[];
  projectPath?: string;
  worktreeId?: string;
}) {
  return events.map((event) =>
    event.kind === 'resolved' ? (
      <EvalWorkspaceEventCard key={event.id} event={event} projectPath={projectPath} worktreeId={worktreeId} />
    ) : (
      <WatchingLine key={event.id} event={event} />
    ),
  );
}

function settledHeading(events: EvalWorkspaceEvent[]): string {
  return events.some((event) => event.kind === 'resolved') ? '最近闭环与观察' : '最近保持观察';
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

function formatDate(value: string): string {
  return new Intl.DateTimeFormat('zh-CN', { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(value));
}
