'use client';

import type { ActiveExecutionProjection } from '@cat-cafe/shared';
import { activeExecutionKey } from '@/stores/activeExecutionStore';
import { ExecutionCancelButton } from '../ExecutionCancelButton';
import { managedCommandActivityLabel } from '../managed-command-activity-label';
import { ThreadChatLink } from './ThreadChatLink';
import type { RunningWork } from './workspace-running-work';

interface ExecutionActionsProps {
  execution: ActiveExecutionProjection;
  onSelectExecution?: (execution: ActiveExecutionProjection) => void;
}

function ExecutionActions({ execution, onSelectExecution }: ExecutionActionsProps) {
  return (
    <>
      {onSelectExecution && execution.kind === 'live_invocation' && execution.turnInvocationId && (
        <button
          type="button"
          onClick={() => onSelectExecution(execution)}
          className="shrink-0 rounded-lg border border-cafe-subtle px-2.5 py-1 text-micro font-semibold text-cafe-secondary transition-colors hover:bg-cafe-surface hover:text-cafe"
          data-testid="workspace-open-running-object"
        >
          详情
        </button>
      )}
      <ExecutionCancelButton execution={execution} label="停止" />
    </>
  );
}

export function WorkspaceRunningWork({
  work,
  catName,
  onSelectExecution,
}: {
  work: RunningWork;
  catName: string;
  onSelectExecution?: (execution: ActiveExecutionProjection) => void;
}) {
  const single = work.executions.length === 1 ? work.executions[0] : undefined;
  const hasLiveTurn = work.executions.some((execution) => execution.kind === 'live_invocation');
  const status = hasLiveTurn ? '回复中' : '等待后台完成';

  return (
    <article className="group py-3.5" data-testid="workspace-running-object">
      <div className="flex items-center gap-3">
        <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-cafe-accent/10 text-cafe-accent">
          <svg
            aria-hidden="true"
            className="h-3.5 w-3.5"
            viewBox="0 0 16 16"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            {hasLiveTurn ? <path d="m5.5 3 6 5-6 5V3Z" /> : <path d="M6 3v10M10 3v10" />}
          </svg>
        </span>
        <div className="min-w-0 flex-1">
          <div className="truncate text-xs font-semibold text-cafe-black">{catName}</div>
          <div className="mt-0.5 truncate text-micro text-cafe-secondary">{work.threadTitle ?? work.threadId}</div>
          <div className="mt-0.5 text-micro text-cafe-muted">
            {status}
            {single?.kind === 'managed_command' && ` · ${managedCommandActivityLabel(single.activity)}`}
          </div>
        </div>
        <ThreadChatLink threadId={work.threadId} />
        {single && <ExecutionActions execution={single} onSelectExecution={onSelectExecution} />}
      </div>
      {!single && (
        <div className="ml-11 mt-2 space-y-2 border-l border-cafe-subtle/60 pl-3">
          {work.executions.map((execution) => (
            <div
              key={activeExecutionKey(execution)}
              className="flex flex-wrap items-center gap-2"
              data-testid="workspace-running-activity"
            >
              <span className="min-w-0 flex-1 text-micro text-cafe-secondary">
                {execution.kind === 'managed_command'
                  ? `后台 · ${managedCommandActivityLabel(execution.activity)}`
                  : '实时回合'}
              </span>
              <ExecutionActions execution={execution} onSelectExecution={onSelectExecution} />
            </div>
          ))}
        </div>
      )}
    </article>
  );
}
