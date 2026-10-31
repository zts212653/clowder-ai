import type { EntrustedWorkOwnerReadV1 } from '@cat-cafe/shared';
import type { ReactNode, Ref } from 'react';
import { useShellCopy } from '@/components/shell/shell-copy';
import { scheduleCopy } from './product-schedule.shell-copy';
import styles from './work-schedule.module.css';

export function ScheduleWorkGroups({
  scrollRef,
  works,
  hasWork,
  partial,
  completed,
  renderWork,
}: {
  scrollRef?: Ref<HTMLDivElement>;
  works: EntrustedWorkOwnerReadV1[];
  hasWork: boolean;
  partial: boolean;
  completed: boolean;
  renderWork: (work: EntrustedWorkOwnerReadV1) => ReactNode;
}) {
  const t = useShellCopy(scheduleCopy);
  return (
    <div ref={scrollRef} className={styles.workScroll} data-testid="schedule-unscheduled">
      {(['blocked', 'doing', 'todo', 'done'] as const).map((state) => {
        const group = works.filter((work) => work.brief.current.state === state);
        if (!group.length) return null;
        return (
          <details key={state} open className="min-w-0" data-schedule-state={state}>
            <summary className="mb-2 cursor-pointer text-xs font-semibold text-cafe-secondary">
              {t.status[state]} · {group.length}
            </summary>
            <div className="grid gap-3">{group.map(renderWork)}</div>
          </details>
        );
      })}
      {!works.length ? (
        <div className="rounded-xl border border-dashed border-cafe-subtle p-6 text-center">
          <p className="text-sm text-cafe-black">
            {partial ? t.partial : hasWork ? t.workEmpty : completed ? t.noCompleted : t.noWork}
          </p>
          {!partial ? (
            <p className="mt-2 text-xs text-cafe-muted">
              {hasWork ? t.filterHint : completed ? t.completionHint : t.emptyHint}
            </p>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
