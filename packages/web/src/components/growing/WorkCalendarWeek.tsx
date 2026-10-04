import type { EntrustedWorkOwnerReadV1 } from '@cat-cafe/shared';
import { calendarDateKey, calendarWeek, workCalendarDates } from './work-calendar';

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
  const dates = works.flatMap(workCalendarDates);
  const shift = (offset: number) => {
    const date = new Date(anchor);
    onAnchor(new Date(date.getFullYear(), date.getMonth(), date.getDate() + offset, 12).getTime());
    onDay(null);
  };
  return (
    <section aria-label="本周安排">
      <div className="mb-2 flex items-center justify-between text-xs text-cafe-secondary">
        <button
          type="button"
          aria-label="上一周"
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
          {new Intl.DateTimeFormat('zh-CN', { year: 'numeric', month: 'long' }).format(anchor)} · 回到本周
        </button>
        <button
          type="button"
          aria-label="下一周"
          className="rounded px-3 py-2 hover:bg-cafe-surface"
          onClick={() => shift(7)}
        >
          ›
        </button>
      </div>
      <div className="grid grid-cols-7 gap-1">
        {calendarWeek(anchor).map((date, index) => {
          const key = calendarDateKey(date.getTime());
          const count = dates.filter((time) => calendarDateKey(time.value) === key).length;
          const selected = key === selectedDay;
          return (
            <button
              type="button"
              key={key}
              aria-label={`${key}，${count} 项安排`}
              aria-pressed={selected}
              onClick={() => onDay(selected ? null : key)}
              className={`flex min-w-0 flex-col items-center gap-1 rounded-lg py-2 text-xs ${selected ? 'bg-cafe-accent text-[var(--cafe-accent-foreground)]' : 'text-cafe-secondary hover:bg-cafe-surface'}`}
            >
              <span className="text-micro opacity-75">{['一', '二', '三', '四', '五', '六', '日'][index]}</span>
              <span
                className={`flex h-7 w-7 items-center justify-center rounded-full text-sm font-semibold ${key === calendarDateKey(today) && !selected ? 'bg-cafe-accent/10 text-cafe-accent ring-1 ring-cafe-accent/40' : ''}`}
              >
                {date.getDate()}
              </span>
              <span className={`h-1 w-1 rounded-full ${count ? 'bg-current' : 'bg-transparent'}`} />
            </button>
          );
        })}
      </div>
    </section>
  );
}
