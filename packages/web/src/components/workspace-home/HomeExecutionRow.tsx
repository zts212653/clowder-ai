'use client';

import type { ActiveExecutionProjection } from '@cat-cafe/shared';
import { type ReactNode, useEffect, useRef, useState } from 'react';
import { CatAvatar } from '@/components/CatAvatar';
import { executionRowCopy } from '@/components/execution-row/execution-row.shell-copy';
import { useShellCopy } from '@/components/shell/shell-copy';
import { ExecutionConversationLink } from './ExecutionConversationLink';
import { requestExecutionDetail } from './execution-detail-request';
import { formatElapsed, homeActivityLabel } from './format';
import { HomeExecutionStopControl } from './HomeExecutionStopControl';
import { homeCopy } from './workspace-home.shell-copy';
import { workspaceV3Copy } from './workspace-v3.shell-copy';

export function HomeExecutionRow({
  execution,
  threadTitle,
  catName,
  here,
  now,
  onSelectExecution,
  detail,
  detailRevision,
}: {
  execution: ActiveExecutionProjection;
  threadTitle: string;
  catName: string;
  here: boolean;
  now: number;
  onSelectExecution?: (execution: ActiveExecutionProjection) => void;
  detail?: ReactNode;
  detailRevision?: number;
}) {
  const row = useRef<HTMLElement>(null);
  const [highlighted, setHighlighted] = useState(false);
  useEffect(() => {
    if (detailRevision === undefined) {
      setHighlighted(false);
      return;
    }
    row.current?.scrollIntoView({ block: 'nearest' });
    setHighlighted(true);
    const timer = window.setTimeout(() => setHighlighted(false), 3200);
    return () => window.clearTimeout(timer);
  }, [detailRevision]);
  const t = useShellCopy(homeCopy);
  const rowWords = useShellCopy(executionRowCopy);
  const words = useShellCopy(workspaceV3Copy);
  const isCommand = execution.kind === 'managed_command';
  const canInspect = isCommand || !!(onSelectExecution && execution.turnInvocationId);
  const activity = homeActivityLabel(execution.activity, rowWords.activity);
  const status = isCommand ? rowWords.compact.managed(activity) : rowWords.compact.working;
  return (
    <article
      ref={row}
      className="home-live-row"
      data-execution-jump-focus={highlighted ? 'true' : undefined}
      data-testid="workspace-running-object"
      data-here={here ? 'true' : undefined}
      data-execution-id={execution.executionId}
      data-execution-thread-id={execution.threadId}
      data-execution-kind={execution.kind}
    >
      <ExecutionConversationLink execution={execution}>
        <span className="home-live-heading">
          <span role="img" aria-label={catName} className="flex-shrink-0">
            <span aria-hidden="true">
              <CatAvatar catId={execution.catId} size={20} ring="none" />
            </span>
          </span>
          <span className="home-live-name text-compact">{catName}</span>
          <span className="home-live-status text-xs" data-tone={isCommand ? 'wait' : 'live'} title={status}>
            <span className="home-execution-status-dot" aria-hidden="true" />
            <span className={isCommand ? 'home-execution-status-full' : undefined}>{status}</span>
            {isCommand && (
              <span className="home-execution-status-compact" aria-hidden="true">
                {status}
              </span>
            )}
          </span>
          <small className="home-live-clock text-xs">{formatElapsed(now - execution.startedAt)}</small>
        </span>
        <span className="home-live-sub text-xs" title={threadTitle}>
          {here && <span data-testid="workspace-running-here">{t.live.here} · </span>}
          {threadTitle}
        </span>
      </ExecutionConversationLink>
      <div className="home-live-actions">
        <button
          type="button"
          className="home-trajectory shell-focusable"
          data-testid="home-execution-trajectory"
          aria-label={words.trajectoryNamed(catName)}
          title={words.trajectoryNamed(catName)}
          disabled={!canInspect}
          onClick={() => (isCommand ? requestExecutionDetail(execution) : onSelectExecution?.(execution))}
        >
          <span aria-hidden="true">›</span>
        </button>
        <HomeExecutionStopControl execution={execution} name={catName} />
      </div>
      {detail}
    </article>
  );
}
