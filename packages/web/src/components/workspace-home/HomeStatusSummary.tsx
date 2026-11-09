'use client';
import { useMemo } from 'react';
import { CatAvatar } from '@/components/CatAvatar';
import { executionRowCopy } from '@/components/execution-row/execution-row.shell-copy';
import { formatWakeTime } from '@/components/execution-row/row-model';
import { SessionChainPanel, type SessionChainProjection } from '@/components/SessionChainPanel';
import { ShellGlyph } from '@/components/shell/ShellIcons';
import { useShellCopy } from '@/components/shell/shell-copy';
import {
  canonicalLauncherDestination,
  type WorkspaceLauncherDestination,
} from '@/components/workspace/WorkspaceLauncher';
import { useCatData } from '@/hooks/useCatData';
import { useThreadLiveness } from '@/hooks/useThreadScopedSelectors';
import { resolveCatNameplateName } from '@/lib/cat-display-name';
import { useActiveExecutionStore } from '@/stores/activeExecutionStore';
import { formatElapsed, homeActivityLabel } from './format';
import { useHomeClock } from './use-home-clock';
import { homeCopy } from './workspace-home.shell-copy';
import { workspaceV3Copy } from './workspace-v3.shell-copy';

export function HomeStatusSummary({
  threadId,
  onSelectDestination,
}: {
  threadId?: string;
  onSelectDestination: (destination: WorkspaceLauncherDestination) => void;
}) {
  const t = useShellCopy(workspaceV3Copy);
  const activity = useShellCopy(executionRowCopy);
  const live = useShellCopy(homeCopy).live;
  const { getCatById } = useCatData();
  const liveness = useThreadLiveness(threadId ?? null);
  const executions = useActiveExecutionStore((state) => state.executionsByKey);
  const current = useMemo(
    () =>
      Object.values(executions)
        .filter((run) => run.threadId === threadId)
        .sort((a, b) => a.startedAt - b.startedAt || a.executionId.localeCompare(b.executionId)),
    [executions, threadId],
  );
  const waits = useActiveExecutionStore((state) => state.waits);
  const now = useHomeClock(current.length > 0, 1000);
  const first = current[0];
  // Nothing runs here but a cat holds the ball: say it is waiting and when it wakes, not "no execution".
  const hold = first
    ? undefined
    : waits.filter((wait) => wait.threadId === threadId).sort((a, b) => a.wakeAt - b.wakeAt)[0];
  const shown = first ?? hold;
  const tone = first?.kind === 'managed_command' || hold ? 'wait' : 'live';
  const clock = first ? formatElapsed(now - first.startedAt) : hold ? live.wakesAt(formatWakeTime(hold.wakeAt)) : null;
  const activeCats = [...new Set(current.map((run) => run.catId))];
  const select = () => onSelectDestination({ ...canonicalLauncherDestination('host', 'status'), label: t.status });
  function content(owner?: SessionChainProjection) {
    const session = owner?.sessions
      .filter((item) => !shown || item.catId === shown.catId)
      .sort((a, b) => b.seq - a.seq)[0];
    const catId = shown?.catId ?? session?.catId;
    const label = catId ? resolveCatNameplateName(catId, getCatById) : undefined;
    const sessionText = session
      ? t.segment(session.seq)
      : first
        ? owner?.loadError
          ? t.sessionUnavailable
          : owner?.loading
            ? t.sessionLoading
            : t.noSessionRecord
        : null;
    const state = first
      ? first.kind === 'managed_command'
        ? activity.compact.managed(homeActivityLabel(first.activity, activity.activity))
        : activity.compact.working
      : hold
        ? live.holding
        : owner?.loadError
          ? t.sessionUnavailable
          : owner?.loading
            ? t.sessionLoading
            : t.noSession;
    return (
      <button
        type="button"
        data-testid="workspace-home-status-summary"
        className="home-status-summary home-live-row shell-focusable"
        onClick={select}
      >
        <span className="home-live-main home-live-link">
          <span className="home-live-heading">
            {catId && <CatAvatar catId={catId} size={20} ring="none" />}
            {label && <span className="home-live-name text-compact">{label}</span>}
            <span className="home-live-status text-xs" data-tone={tone}>
              {shown && <span className="home-execution-status-dot" aria-hidden="true" />}
              {state}
            </span>
            {clock && <small className="home-live-clock text-xs">{clock}</small>}
          </span>
          {sessionText && (
            <span className="home-live-sub text-xs">
              {sessionText}
              {activeCats.length > 1 && ` · ${t.otherCats(activeCats.length - 1)}`}
            </span>
          )}
        </span>
        <span className="home-trajectory" aria-hidden="true">
          ›
        </span>
      </button>
    );
  }
  return (
    <section className="home-section" aria-labelledby="home-status-title">
      <header className="home-card-head">
        <ShellGlyph name="activity" className="home-section-icon" />
        <h2 id="home-status-title" className="home-card-title text-sm">
          {t.status}
        </h2>
        <button type="button" className="home-all shell-focusable ml-auto text-xs" onClick={select}>
          {t.all} ›
        </button>
      </header>
      {threadId ? (
        <SessionChainPanel
          threadId={threadId}
          catInvocations={liveness.catInvocations}
          activeInvocations={liveness.activeInvocations}
          renderProjection={content}
          refreshOnRunEnd
        />
      ) : (
        content()
      )}
    </section>
  );
}
