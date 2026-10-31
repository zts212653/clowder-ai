'use client';

import { AppTooltip } from '../AppTooltip';
import { ExecutionCancelButton } from '../ExecutionCancelButton';
import styles from './ExecutionRow.module.css';
import { ExecutionRowActionIcon } from './ExecutionRowActionIcon';
import type { ExecutionRowWords } from './execution-row.shell-copy';
import type { ExecutionRowController } from './useExecutionRow';

export function ExecutionRowActions({
  controller,
  words,
}: {
  controller: ExecutionRowController;
  words: ExecutionRowWords;
}) {
  const { model, forceReset } = controller;
  const resetDetail = model.forceReset.map((reason) => words.forceResetReason[reason]).join(' · ');
  const resumeLabel = words.actions.recover;

  return (
    <>
      {model.forceReset.length > 0 ? (
        <AppTooltip label={words.actions.forceReset} detail={resetDetail} side="top" multiline>
          <button
            type="button"
            data-testid="execution-row-force-reset"
            aria-label={words.actions.forceReset}
            onClick={forceReset.request}
            className="shell-focusable inline-flex flex-none items-center gap-1 rounded-md px-2 py-1 font-semibold transition-opacity hover:opacity-90"
            style={{ backgroundColor: 'var(--semantic-critical-surface)', color: 'var(--semantic-critical)' }}
          >
            <ExecutionRowActionIcon
              kind="reset"
              className={`${styles.actionIcon} h-4 w-4`}
              testId="execution-row-force-reset-icon"
            />
            <span className={styles.actionLabel} data-testid="execution-row-force-reset-label">
              {words.actions.forceReset}
            </span>
          </button>
        </AppTooltip>
      ) : null}
      {model.resumeOnRow ? (
        <AppTooltip label={resumeLabel} side="top">
          <button
            type="button"
            data-testid="execution-row-resume"
            aria-label={resumeLabel}
            onClick={() => void controller.commands.handleContinue()}
            className="shell-focusable inline-flex flex-none items-center gap-1 rounded-md bg-[var(--semantic-success)] px-2 py-1 text-[var(--cafe-surface)] hover:opacity-90"
          >
            <ExecutionRowActionIcon
              kind={'recover'}
              className={`${styles.actionIcon} h-4 w-4`}
              testId="execution-row-resume-icon"
            />
            <span className={styles.actionLabel} data-testid="execution-row-resume-label">
              {resumeLabel}
            </span>
          </button>
        </AppTooltip>
      ) : null}
      {model.stop.kind === 'button' ? (
        <AppTooltip label={words.actions.stop} side="top">
          <span data-testid="execution-row-stop" className="flex-none">
            <ExecutionCancelButton
              execution={model.stop.execution}
              ariaLabel={words.actions.stop}
              label={
                <>
                  <ExecutionRowActionIcon
                    kind="stop"
                    className={`${styles.actionIcon} h-4 w-4`}
                    testId="execution-row-stop-icon"
                  />
                  <span className={styles.actionLabel} data-testid="execution-row-stop-label">
                    {words.actions.stop}
                  </span>
                </>
              }
              className="shell-focusable inline-flex items-center gap-1 rounded-md border border-[var(--shell-hairline-strong)] bg-[var(--shell-paper)] px-2 py-1 font-medium text-[var(--shell-body)] hover:text-[var(--semantic-critical)]"
            />
          </span>
        </AppTooltip>
      ) : null}
    </>
  );
}
