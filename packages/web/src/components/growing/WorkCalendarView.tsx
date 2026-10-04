import type { EntrustedWorkOwnerReadV1 } from '@cat-cafe/shared';
import { useEffect, useRef, useState } from 'react';
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
  overdue,
}: {
  works: EntrustedWorkOwnerReadV1[];
  month: number;
  today: number;
  selectedDay: string | null;
  onMonth: (value: number) => void;
  onDay: (value: string | null) => void;
  overdue: number;
}) {
  const calendar = useRef<HTMLElement>(null);
  const [wide, setWide] = useState(false);
  const [chosenView, setChosenView] = useState<'week' | 'month' | null>(null);
  const view = chosenView ?? (wide ? 'month' : 'week');
  useEffect(() => {
    const panel = calendar.current?.closest('[data-testid="product-schedule-panel"]');
    if (!panel || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(([entry]) => {
      if (entry) setWide(entry.contentRect.width >= 820);
    });
    observer.observe(panel);
    return () => observer.disconnect();
  }, []);
  return (
    <section ref={calendar} aria-label="工作日历" className={styles.calendar} data-view={view}>
      <div className="rounded-xl border border-cafe-subtle/70 bg-cafe-surface/40 p-3">
        <div className="mb-1 flex items-center justify-between gap-2">
          <span
            className="text-xs font-medium text-cafe-secondary"
            title={Intl.DateTimeFormat().resolvedOptions().timeZone}
          >
            时间安排 · 本地时间
          </span>
          <fieldset
            className="flex gap-0.5 rounded-md border border-cafe-subtle bg-[var(--console-card-bg)] p-0.5"
            aria-label="日历视图"
          >
            {(['week', 'month'] as const).map((mode) => (
              <button
                key={mode}
                type="button"
                aria-pressed={view === mode}
                onClick={() => {
                  setChosenView(mode);
                  if (
                    mode === 'week' &&
                    new Date(month).getMonth() === new Date(today).getMonth() &&
                    new Date(month).getFullYear() === new Date(today).getFullYear()
                  )
                    onMonth(today);
                  onDay(null);
                }}
                className={`rounded px-2.5 py-1 text-xs ${view === mode ? 'bg-cafe-accent/10 font-semibold text-cafe-accent' : 'text-cafe-secondary'}`}
              >
                {mode === 'week' ? '周' : '月'}
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
      {overdue > 0 ? <p className="mt-2 px-1 text-xs text-semantic-critical">{overdue} 件工作已过截止时间</p> : null}
    </section>
  );
}
