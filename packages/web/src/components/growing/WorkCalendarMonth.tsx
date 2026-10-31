import type { EntrustedWorkOwnerReadV1 } from '@cat-cafe/shared';
import { useShellCopy } from '@/components/shell/shell-copy';
import { scheduleCopy } from './product-schedule.shell-copy';
import { calendarDateKey, calendarDays, changeCalendarMonth, workCalendarDates, workTitle } from './work-calendar';

export function WorkCalendarMonth({
  works,
  month,
  today,
  selectedDay,
  onMonth,
  onDay,
}: {
  works: EntrustedWorkOwnerReadV1[];
  month: number;
  today: number;
  selectedDay: string | null;
  onMonth: (month: number) => void;
  onDay: (day: string | null) => void;
}) {
  const t = useShellCopy(scheduleCopy);
  const todayKey = calendarDateKey(today);
  const currentMonth = new Date(month).getMonth();
  const events = works.flatMap((work) => workCalendarDates(work).map((time) => ({ work, time })));
  const control =
    'rounded-md border border-cafe-subtle px-2.5 py-1.5 text-xs text-cafe-secondary hover:bg-cafe-surface';
  return (
    <section
      aria-label={t.monthLabel}
      className="mt-5 min-w-0 rounded-xl border border-cafe-subtle bg-[var(--console-card-bg)]"
    >
      <header className="flex flex-wrap items-center justify-between gap-2 px-3 py-3">
        <h3 className="text-sm font-semibold text-cafe-black">
          {new Intl.DateTimeFormat(t.locale, { year: 'numeric', month: 'long' }).format(month)}
        </h3>
        <div className="flex items-center gap-1">
          <button
            type="button"
            className={control}
            aria-label={t.previousMonth}
            onClick={() => {
              onMonth(changeCalendarMonth(month, -1));
              onDay(null);
            }}
          >
            ‹
          </button>
          <button
            type="button"
            className={control}
            onClick={() => {
              onMonth(today);
              onDay(todayKey);
            }}
          >
            {t.today}
          </button>
          <button
            type="button"
            className={control}
            aria-label={t.nextMonth}
            onClick={() => {
              onMonth(changeCalendarMonth(month, 1));
              onDay(null);
            }}
          >
            ›
          </button>
        </div>
      </header>
      <div
        className="grid grid-cols-7 border-t border-cafe-subtle text-center text-micro text-cafe-muted"
        aria-hidden="true"
      >
        {[t.weekday.mon, t.weekday.tue, t.weekday.wed, t.weekday.thu, t.weekday.fri, t.weekday.sat, t.weekday.sun].map(
          (day) => (
            <div key={day} className="py-2">
              {day}
            </div>
          ),
        )}
      </div>
      <div className="grid grid-cols-7 overflow-hidden rounded-b-xl">
        {calendarDays(month).map((date) => {
          const key = calendarDateKey(date.getTime());
          const entries = events.filter(({ time }) => calendarDateKey(time.value) === key);
          const outside = date.getMonth() !== currentMonth;
          const selected = selectedDay === key;
          return (
            <button
              key={key}
              type="button"
              aria-label={t.dayCount(key, entries.length)}
              aria-pressed={selected}
              data-calendar-date={key}
              onClick={() => onDay(selected ? null : key)}
              className={`min-h-[3.25rem] min-w-0 border-t border-cafe-subtle/60 p-1 text-left align-top transition-colors sm:min-h-[3.75rem] sm:p-2 ${selected ? 'bg-cafe-accent/10 ring-1 ring-inset ring-cafe-accent' : 'hover:bg-cafe-surface'} ${outside ? 'text-cafe-muted/60' : 'text-cafe-secondary'}`}
            >
              <span
                className={`flex h-6 w-6 items-center justify-center rounded-full text-xs ${key === todayKey ? 'bg-cafe-accent font-semibold text-[var(--cafe-accent-foreground)]' : ''}`}
              >
                {date.getDate()}
              </span>
              <span className="mt-1 block space-y-1">
                {entries.slice(0, 2).map(({ work, time }) => (
                  <span
                    key={`${work.envelope.subjectRef}:${time.role}`}
                    title={`${t.time[time.role]} · ${workTitle(work)}`}
                    className={`block truncate rounded px-1 py-0.5 text-micro ${time.role === 'business_deadline' && time.value < today && !work.completion ? 'bg-semantic-critical-surface text-semantic-critical' : 'bg-cafe-accent/10 text-cafe-accent'}`}
                  >
                    {t.time[time.role]} · {workTitle(work)}
                  </span>
                ))}
                {entries.length > 2 ? (
                  <span className="block text-micro text-cafe-muted">{t.more(entries.length - 2)}</span>
                ) : null}
              </span>
            </button>
          );
        })}
      </div>
    </section>
  );
}
