'use client';

import { activeExecutionKey } from '@/stores/activeExecutionStore';
import { CatAvatar } from '../CatAvatar';
import { ExecutionCancelButton } from '../ExecutionCancelButton';
import { useShellCopy } from '../shell/shell-copy';
import { type ExecutionRowWords, executionRowCopy } from './execution-row.shell-copy';
/**
 * F322 original-B: what opens under the one row. It overlays the conversation (the caller positions it) and
 * never pushes the chat down. Two sections, both reading the same controller as the row:
 *  - 在跑: every canonical run, each with its own ■ (ExecutionCancelButton: same pending / blocked / error flow);
 *  - 排队: the visible queue, with the wait reason, the pause reason, 继续/恢复, 清空排队 and the draggable
 *    entry list (QueueEntryList = the old QueueEntryRow, so every per-entry action survives).
 */
import { QueueEntryList } from './QueueEntryList';
import { formatClock } from './row-model';
import type { ExecutionRowController } from './useExecutionRow';

function WaitLine({ controller, words }: { controller: ExecutionRowController; words: ExecutionRowWords }) {
  const { model, resolveCatName } = controller;
  const wait = model.waitInfo;
  if (!wait || model.visibleQueueCount === 0) return null;
  return (
    <div data-testid="execution-row-wait" className="px-3 py-1 text-xs text-cafe-muted">
      {wait.kind === 'active_turn'
        ? words.panel.waitActive(resolveCatName(wait.catId), wait.elapsedLabel ?? '')
        : words.panel.waitSchedule(wait.catIds.map((catId) => resolveCatName(catId)).join(words.panel.nameSeparator))}
    </div>
  );
}

function RunningSection({ controller, words }: { controller: ExecutionRowController; words: ExecutionRowWords }) {
  const { executions, silent, now, resolveCatName } = controller;
  if (executions.length === 0) return null;
  const ordered = [...executions].sort(
    (a, b) => a.startedAt - b.startedAt || a.executionId.localeCompare(b.executionId),
  );
  return (
    <section aria-label={words.panel.running(executions.length)} data-testid="execution-row-running">
      <div className="px-3 pt-2 pb-1 text-xs font-medium text-cafe-muted">{words.panel.running(executions.length)}</div>
      <ul className="flex flex-col">
        {ordered.map((execution) => {
          const quiet = silent[activeExecutionKey(execution)] !== undefined;
          const what =
            execution.kind === 'managed_command'
              ? words.activity[execution.activity ?? 'command']
              : words.panel.realtime;
          return (
            <li
              key={activeExecutionKey(execution)}
              data-testid="execution-row-run"
              className="flex items-center gap-2 px-3 py-1.5 text-xs"
            >
              <button
                type="button"
                onClick={() => controller.locate(execution)}
                aria-label={`${words.actions.locate}: ${resolveCatName(execution.catId)} ${what}`}
                className="shell-focusable flex min-w-0 flex-1 items-center gap-2 text-left"
              >
                <CatAvatar catId={execution.catId} size={18} />
                <span className="truncate font-medium text-cafe-secondary">{resolveCatName(execution.catId)}</span>
                <span className="text-cafe-muted">{what}</span>
                {quiet ? <span className="text-conn-amber-text">{words.panel.quiet}</span> : null}
                <span className="ml-auto tabular-nums text-cafe-muted">{formatClock(now - execution.startedAt)}</span>
              </button>
              <ExecutionCancelButton
                execution={execution}
                label={words.actions.stop}
                pendingLabel={words.actions.stopping}
              />
            </li>
          );
        })}
      </ul>
    </section>
  );
}

function QueueSection({ controller, words }: { controller: ExecutionRowController; words: ExecutionRowWords }) {
  const { model, view, commands, convergence, resolveCatName } = controller;
  if (model.visibleQueueCount === 0) return null;
  return (
    <section aria-label={words.panel.queue(model.visibleQueueCount)} data-testid="execution-row-queue">
      <div className="flex items-center gap-2 px-3 pt-2 pb-1 text-xs">
        <span className="font-medium text-cafe-muted">{words.panel.queue(model.visibleQueueCount)}</span>
        <span className="ml-auto flex items-center gap-2">
          {model.resume ? (
            <button
              type="button"
              data-testid="execution-row-queue-resume"
              onClick={() => void commands.handleContinue()}
              className="rounded-md bg-[var(--semantic-success)] px-2 py-1 text-[var(--cafe-surface)] hover:opacity-90"
            >
              {words.actions.recover}
            </button>
          ) : null}
          <button
            type="button"
            data-testid="execution-row-queue-clear"
            onClick={() => void commands.handleClear()}
            title={words.panel.clearTitle}
            className="text-cafe-muted transition-colors hover:text-conn-red-text"
          >
            {words.panel.clear}
          </button>
        </span>
      </div>
      <WaitLine controller={controller} words={words} />
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
  const words = useShellCopy(executionRowCopy);
  return (
    <div
      data-testid="execution-row-panel"
      className="absolute inset-x-0 bottom-full z-20 max-h-[50vh] overflow-y-auto rounded-t-xl border border-b-0 shadow-lg"
      style={{ background: 'var(--cafe-surface)', borderColor: 'var(--cafe-border, currentColor)' }}
    >
      <RunningSection controller={controller} words={words} />
      <QueueSection controller={controller} words={words} />
    </div>
  );
}
