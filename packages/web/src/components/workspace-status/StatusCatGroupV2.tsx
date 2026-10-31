'use client';

import { type CSSProperties, useState } from 'react';
import { formatCatName, useCatData } from '@/hooks/useCatData';
import { useElapsedTime } from '@/hooks/useElapsedTime';
import { catColorVar } from '@/lib/cat-slug';
import { useChatStore } from '@/stores/chatStore';
import { CatNameplate } from '../CatNameplate';
import type { RightStatusPanelProps } from '../RightStatusPanel';
import { SessionIdTag } from '../SessionChainInputs';
import type { SessionChainProjection, SessionSummary } from '../SessionChainPanel';
import { sessionChainCopy } from '../session-chain.shell-copy';
import { useShellCopy } from '../shell/shell-copy';
import { useF307ExperienceWorkbenchStore } from '../workbench/experience-workbench-store';
import { createAgentRunSurface } from '../workbench/real-surface-adapters';
import { SessionRowV2 } from './SessionRowV2';
import { statusPageCopy } from './status-page.shell-copy';
import type { StatusLastRun } from './status-run-history';

export function StatusCatGroupV2({
  catId,
  owner,
  props,
  lastRun,
  onView,
}: {
  catId: string;
  owner: SessionChainProjection;
  props: RightStatusPanelProps;
  lastRun?: StatusLastRun;
  onView: (session: SessionSummary) => void;
}) {
  const t = useShellCopy(statusPageCopy);
  const chain = useShellCopy(sessionChainCopy);
  const { getCatById } = useCatData();
  const cat = getCatById(catId);
  const running = owner.runningCatIds.has(catId);
  const invocation = props.catInvocations[catId];
  // Message ordering and client telemetry clocks do not establish a shared run identity.
  const slot = Object.entries(props.activeInvocations ?? {}).find(([, item]) => item.catId === catId);
  const elapsed = useElapsedTime(running ? (slot?.[1].startedAt ?? invocation?.startedAt) : undefined);
  const seconds = Math.floor(elapsed / 1000);
  const duration = `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
  // Legacy hydration keys are presentation bookkeeping, not copyable runtime IDs.
  const parentId = slot?.[0];
  const observedParentId = parentId?.startsWith('hydrated-') ? undefined : parentId;
  const invocationId = running
    ? invocation?.invocationId === parentId
      ? (invocation?.turnInvocationId ?? observedParentId)
      : observedParentId
    : (lastRun?.invocationId ?? invocation?.turnInvocationId ?? invocation?.invocationId);
  const trajectoryId = running
    ? invocation?.invocationId === parentId
      ? invocation.turnInvocationId
      : undefined
    : (lastRun?.invocationId ?? invocation?.turnInvocationId);
  const sessions = owner.sessions.filter((session) => session.catId === catId);
  const current = sessions.filter((session) => session.status === 'active');
  const archived = sessions
    .filter((session) => session.status !== 'active')
    .sort((a, b) => (b.sealedAt ?? b.createdAt) - (a.sealedAt ?? a.createdAt));
  const visibleArchived = archived.filter((session) => !owner.retryFragmentIds.has(session.id));
  const collapsedRetries = archived.length - visibleArchived.length;
  const [historyOpen, setHistoryOpen] = useState(false);
  const status = props.catStatuses[catId];
  const label =
    status === 'error'
      ? t.error
      : running
        ? status === 'spawning'
          ? t.starting
          : status === 'alive_but_silent'
            ? t.silent
            : status === 'suspected_stall'
              ? t.stalled
              : t.running
        : t.idle;
  const dot =
    status === 'error' ? 'var(--semantic-critical)' : running ? 'var(--semantic-success)' : 'var(--cafe-text-muted)';
  const lastRunAt =
    lastRun?.observedAt ??
    (invocation?.startedAt && invocation.durationMs != null ? invocation.startedAt + invocation.durationMs : undefined);
  return (
    <section
      data-testid="status-cat-group"
      data-cat-id={catId}
      data-running={running}
      className="status-v2-cat"
      style={
        {
          '--status-cat-color': catColorVar(catId, 'primary'),
          '--status-cat-surface': catColorVar(catId, 'surface'),
        } as CSSProperties
      }
    >
      <div className="status-v2-cat-heading">
        <CatNameplate catId={catId} name={cat ? formatCatName(cat) : catId} />
        <span className="status-v2-state">
          <span className="status-v2-dot" style={{ background: dot }} />
          {label}
          {running
            ? elapsed > 0
              ? ` · ${duration}`
              : ''
            : lastRunAt
              ? ` · ${t.lastRun(new Date(lastRunAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }))}`
              : ''}
        </span>
        {trajectoryId && (
          <button
            type="button"
            className="status-v2-run-link"
            onClick={() => {
              // Match chat: the original resolver owns canonical session identity.
              useF307ExperienceWorkbenchStore.getState().dispatch({
                type: 'open-surface',
                surface: createAgentRunSurface({ threadId: props.threadId, invocationId: trajectoryId, catId }),
                entitlement: { kind: 'user', reason: 'sidecar-action' },
              });
              useChatStore.getState().setRightPanelMode('workspace');
              useChatStore.getState().setRightPanelOpen(true);
            }}
          >
            {running ? t.viewRun : t.viewLastRun} ›
          </button>
        )}
      </div>
      {invocationId && (
        <div className="status-v2-runtime status-v2-muted">
          <span>{running ? t.runId : t.lastRunId}</span>
          <SessionIdTag id={invocationId} label={t.runId} />
        </div>
      )}
      {current.map((session) => (
        <SessionRowV2
          key={session.id}
          session={session}
          owner={owner}
          invocation={invocation}
          threadId={props.threadId}
          onView={onView}
        />
      ))}
      {current.length === 0 && (
        <p className="status-v2-muted">
          {owner.loading ? t.loading : owner.loadError ? t.sessionsUnavailable : t.noUnarchived}
        </p>
      )}
      {archived.length > 0 && (
        <div className="status-v2-history">
          <button
            type="button"
            aria-expanded={historyOpen}
            data-testid={`sealed-toggle-${catId}`}
            onClick={() => setHistoryOpen((value) => !value)}
          >
            {historyOpen ? '▾' : '›'} {t.archived(archived.length)}
          </button>
          {historyOpen && collapsedRetries > 0 && (
            <p className="status-v2-muted">{chain.retryFragments(collapsedRetries)}</p>
          )}
          {historyOpen &&
            visibleArchived.map((session) => (
              <SessionRowV2
                key={session.id}
                session={session}
                owner={owner}
                threadId={props.threadId}
                onView={onView}
              />
            ))}
        </div>
      )}
    </section>
  );
}
