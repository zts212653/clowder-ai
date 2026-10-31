import type { EntrustedWorkOwnerReadV1 } from '@cat-cafe/shared';
import { useShellCopy } from '@/components/shell/shell-copy';
import { scheduleCopy } from './product-schedule.shell-copy';
import { calendarDateKey, calendarWeek, workCalendarDates, workTitle } from './work-calendar';

export function WorkCalendarWeek({
  works,
  anchor,
  today,
  selectedDay,
  onDay,
  onAnchor,
}: {
  works: EntrustedWorkOwnerReadV1[];
  anchor: number;
  today: number;
  selectedDay: string | null;
  onDay: (day: string | null) => void;
  onAnchor: (value: number) => void;
}) {
  const t = useShellCopy(scheduleCopy);
  const events = works.flatMap((work) => workCalendarDates(work).map((time) => ({ work, time })));
  const weekdays = [
    t.weekday.mon,
    t.weekday.tue,
    t.weekday.wed,
    t.weekday.thu,
    t.weekday.fri,
    t.weekday.sat,
    t.weekday.sun,
  ];
  const shift = (offset: number) => {
    const date = new Date(anchor);
    onAnchor(new Date(date.getFullYear(), date.getMonth(), date.getDate() + offset, 12).getTime());
    onDay(null);
  };
  return (
    <section aria-label={t.weekLabel}>
      <div className="mb-2 flex items-center justify-between text-xs text-cafe-secondary">
        <button
          type="button"
          aria-label={t.previousWeek}
          className="rounded px-3 py-2 hover:bg-cafe-surface"
          onClick={() => shift(-7)}
        >
          ‹
        </button>
        <button
          type="button"
          className="rounded px-2 py-1 hover:bg-cafe-surface"
          onClick={() => {
            onAnchor(today);
            onDay(null);
          }}
        >
          {new Intl.DateTimeFormat(t.locale, { year: 'numeric', month: 'long' }).format(anchor)} · {t.thisWeek}
        </button>
        <button
          type="button"
          aria-label={t.nextWeek}
          className="rounded px-3 py-2 hover:bg-cafe-surface"
          onClick={() => shift(7)}
        >
          ›
        </button>
      </div>
      <div className="grid grid-cols-7 gap-1">
        {calendarWeek(anchor).map((date, index) => {
          const key = calendarDateKey(date.getTime());
          const entries = events.filter(({ time }) => calendarDateKey(time.value) === key);
          const selected = key === selectedDay;
          return (
            <button
              type="button"
              key={key}
              aria-label={t.dayCount(key, entries.length)}
              aria-pressed={selected}
              data-calendar-date={key}
              onClick={() => onDay(selected ? null : key)}
              className={`flex min-w-0 flex-col items-center gap-1 rounded-lg py-2 text-xs ${selected ? 'bg-cafe-accent text-[var(--cafe-accent-foreground)]' : 'text-cafe-secondary hover:bg-cafe-surface'}`}
            >
              <span className="text-micro opacity-75">{weekdays[index]}</span>
              <span
                className={`flex h-7 w-7 items-center justify-center rounded-full text-sm font-semibold ${key === calendarDateKey(today) && !selected ? 'bg-cafe-accent/10 text-cafe-accent ring-1 ring-cafe-accent/40' : ''}`}
              >
                {date.getDate()}
              </span>
              {entries.map(({ work, time }) => (
                <span
                  key={`${work.envelope.subjectRef}:${time.role}`}
                  title={`${t.time[time.role]} · ${workTitle(work)}`}
                  className="w-full truncate px-1 text-left text-micro"
                >
                  {t.time[time.role]} · {workTitle(work)}
                </span>
              ))}
            </button>
          );
        })}
      </div>
    </section>
  );
}
