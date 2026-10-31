import type { EntrustedWorkOwnerReadV1 } from '@cat-cafe/shared';
import { useShellCopy } from '@/components/shell/shell-copy';
import { scheduleCopy } from './product-schedule.shell-copy';
import { WorkCalendarMonth } from './WorkCalendarMonth';
import { WorkCalendarWeek } from './WorkCalendarWeek';
import styles from './work-schedule.module.css';

export function WorkCalendarView({
  works,
  month,
  today,
  selectedDay,
  onMonth,
  onDay,
  view,
  onView,
}: {
  works: EntrustedWorkOwnerReadV1[];
  month: number;
  today: number;
  selectedDay: string | null;
  onMonth: (value: number) => void;
  onDay: (value: string | null) => void;
  overdue: number;
  view: 'week' | 'month';
  onView: (value: 'week' | 'month') => void;
}) {
  const t = useShellCopy(scheduleCopy);
  return (
    <section aria-label={t.calendar} className={styles.calendar} data-view={view}>
      <div className="rounded-xl border border-cafe-subtle/70 bg-cafe-surface/40 p-3">
        <div className="mb-1 flex items-center justify-between gap-2">
          <span
            className="text-xs font-medium text-cafe-secondary"
            title={Intl.DateTimeFormat().resolvedOptions().timeZone}
          >
            {t.timezone}
          </span>
          <fieldset
            className="flex gap-0.5 rounded-md border border-cafe-subtle bg-[var(--console-card-bg)] p-0.5"
            aria-label={t.views}
          >
            {(['week', 'month'] as const).map((mode) => (
              <button
                key={mode}
                type="button"
                aria-pressed={view === mode}
                onClick={() => onView(mode)}
                className={`rounded px-2.5 py-1 text-xs ${view === mode ? 'bg-cafe-accent/10 font-semibold text-cafe-accent' : 'text-cafe-secondary'}`}
              >
                {t[mode]}
              </button>
            ))}
          </fieldset>
        </div>
        {view === 'week' ? (
          <WorkCalendarWeek
            works={works}
            anchor={month}
            today={today}
            selectedDay={selectedDay}
            onDay={onDay}
            onAnchor={onMonth}
          />
        ) : (
          <WorkCalendarMonth
            works={works}
            month={month}
            today={today}
            selectedDay={selectedDay}
            onMonth={onMonth}
            onDay={onDay}
          />
        )}
      </div>
    </section>
  );
}
