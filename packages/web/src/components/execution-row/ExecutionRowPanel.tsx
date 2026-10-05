'use client';

import { activeExecutionKey } from '@/stores/activeExecutionStore';
import { CatAvatar } from '../CatAvatar';
import { ExecutionCancelButton } from '../ExecutionCancelButton';
/**
 * F322 original-B: what opens under the one row. It overlays the conversation (the caller positions it) and
 * never pushes the chat down. Two sections, both reading the same controller as the row:
 *  - 在跑: every canonical run, each with its own ■ (ExecutionCancelButton: same pending / blocked / error flow);
 *  - 排队: the visible queue, with the wait reason, the pause reason, 继续/恢复, 清空排队 and the draggable
 *    entry list (QueueEntryList = the old QueueEntryRow, so every per-entry action survives).
 */
import { managedCommandActivityLabel } from '../managed-command-activity-label';
import { QueueEntryList } from './QueueEntryList';
import { formatClock, PAUSE_REASON_COPY } from './row-model';
import type { ExecutionRowController } from './useExecutionRow';

function WaitLine({ controller }: { controller: ExecutionRowController }) {
  const { model, resolveCatName } = controller;
  const wait = model.waitInfo;
  if (model.queuePaused && model.pauseReason) {
    return (
      <div data-testid="execution-row-pause-reason" className="px-3 py-1 text-xs text-conn-amber-text">
        {PAUSE_REASON_COPY[model.pauseReason]}
      </div>
    );
  }
  if (!wait || model.visibleQueueCount === 0) return null;
  return (
    <div data-testid="execution-row-wait" className="px-3 py-1 text-xs text-cafe-muted">
      {wait.kind === 'active_turn' ? (
        <>
          等待 <span className="font-medium text-cafe-secondary">{resolveCatName(wait.catId)}</span> 当前回合
          {wait.elapsedLabel ? `（已运行 ${wait.elapsedLabel}）` : ''}
        </>
      ) : (
        <>
          等待{' '}
          <span className="font-medium text-cafe-secondary">
            {wait.catIds.map((catId) => resolveCatName(catId)).join('、')}
          </span>{' '}
          调度
        </>
      )}
    </div>
  );
}

function RunningSection({ controller }: { controller: ExecutionRowController }) {
  const { executions, silent, now, resolveCatName } = controller;
  if (executions.length === 0) return null;
  const ordered = [...executions].sort(
    (a, b) => a.startedAt - b.startedAt || a.executionId.localeCompare(b.executionId),
  );
  return (
    <section aria-label="在跑" data-testid="execution-row-running">
      <div className="px-3 pt-2 pb-1 text-xs font-medium text-cafe-muted">在跑 {executions.length}</div>
      <ul className="flex flex-col">
        {ordered.map((execution) => {
          const quiet = silent[activeExecutionKey(execution)] !== undefined;
          const what =
            execution.kind === 'managed_command' ? managedCommandActivityLabel(execution.activity) : '实时回合';
          return (
            <li
              key={activeExecutionKey(execution)}
              data-testid="execution-row-run"
              className="flex items-center gap-2 px-3 py-1.5 text-xs"
            >
              <CatAvatar catId={execution.catId} size={18} />
              <span className="font-medium text-cafe-secondary">{resolveCatName(execution.catId)}</span>
              <span className="text-cafe-muted">{what}</span>
              {quiet ? <span className="text-conn-amber-text">没动静</span> : null}
              <span className="ml-auto tabular-nums text-cafe-muted">{formatClock(now - execution.startedAt)}</span>
              <ExecutionCancelButton execution={execution} label="■" />
            </li>
          );
        })}
      </ul>
    </section>
  );
}

function QueueSection({ controller }: { controller: ExecutionRowController }) {
  const { model, view, commands, convergence, resolveCatName } = controller;
  if (model.visibleQueueCount === 0 && !model.queuePaused) return null;
  return (
    <section aria-label="排队" data-testid="execution-row-queue">
      <div className="flex items-center gap-2 px-3 pt-2 pb-1 text-xs">
        <span className="font-medium text-cafe-muted">排队 {model.visibleQueueCount}</span>
        <span className="ml-auto flex items-center gap-2">
          {model.resume ? (
            <button
              type="button"
              data-testid="execution-row-queue-resume"
              onClick={() => void commands.handleContinue()}
              className="rounded-md bg-[var(--semantic-success)] px-2 py-1 text-[var(--cafe-surface)] hover:opacity-90"
            >
              {model.resume === 'continue' ? '继续' : '恢复'}
            </button>
          ) : null}
          <button
            type="button"
            data-testid="execution-row-queue-clear"
            onClick={() => void commands.handleClear()}
            title="全部停止后续处理（保留原消息）"
            className="text-cafe-muted transition-colors hover:text-conn-red-text"
          >
            清空排队
          </button>
        </span>
      </div>
      <WaitLine controller={controller} />
      <QueueEntryList
        view={view}
        commands={commands}
        convergence={convergence}
        resolveCatName={resolveCatName}
        className="flex flex-col gap-0.5 p-1"
      />
    </section>
  );
}

export function ExecutionRowPanel({ controller }: { controller: ExecutionRowController }) {
  return (
    <div
      data-testid="execution-row-panel"
      className="absolute inset-x-0 bottom-full z-20 max-h-[50vh] overflow-y-auto rounded-t-xl border border-b-0 shadow-lg"
      style={{ background: 'var(--cafe-surface)', borderColor: 'var(--cafe-border, currentColor)' }}
    >
      <RunningSection controller={controller} />
      <QueueSection controller={controller} />
    </div>
  );
}
