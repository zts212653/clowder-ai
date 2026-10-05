import type { EntrustedWorkOwnerReadV1 } from '@cat-cafe/shared';

export const WORK_STATUS = { todo: '待开始', doing: '进行中', blocked: '已阻塞', done: '已完成' } as const;
export const WORK_TIME = {
  business_deadline: '截止',
  review_by: '请你审阅',
  execution_trigger: '执行时间',
  planned_start: '计划开始',
  actual_start: '开始',
  estimated_completion: '预计完成',
  admitted_at: '接下',
  completed_at: '完成',
} as const;

export function calendarDateKey(value: number): string {
  const date = new Date(value);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

export function workDates(work: EntrustedWorkOwnerReadV1) {
  // Runtime wakeups are not business appointments or promised delivery dates.
  return work.timeRefs.filter((time) => time.role !== 'execution_trigger');
}

export function workTitle(work: EntrustedWorkOwnerReadV1): string {
  if (work.work) return work.work.title;
  return work.brief.outcome.state === 'known' ? work.brief.outcome.value : '待补充工作目标';
}

/** Date markers from existing Task facts; never written back as business dates. */
export function workCalendarDates(
  work: EntrustedWorkOwnerReadV1,
): Array<{ role: keyof typeof WORK_TIME; value: number }> {
  const dates: Array<{ role: keyof typeof WORK_TIME; value: number }> = [...workDates(work)];
  if (work.completion?.recordedAt !== undefined)
    dates.push({ role: 'completed_at', value: work.completion.recordedAt });
  if (dates.length === 0 && work.work) dates.push({ role: 'admitted_at', value: work.work.admittedAt });
  return dates;
}

export function calendarWeek(value: number): Date[] {
  const date = new Date(value);
  const monday = new Date(date.getFullYear(), date.getMonth(), date.getDate() - ((date.getDay() + 6) % 7), 12);
  return Array.from(
    { length: 7 },
    (_, index) => new Date(monday.getFullYear(), monday.getMonth(), monday.getDate() + index, 12),
  );
}

export function calendarDays(month: number): Date[] {
  const date = new Date(month);
  const first = new Date(date.getFullYear(), date.getMonth(), 1, 12);
  first.setDate(first.getDate() - ((first.getDay() + 6) % 7));
  return Array.from(
    { length: 42 },
    (_, index) => new Date(first.getFullYear(), first.getMonth(), first.getDate() + index, 12),
  );
}

export function changeCalendarMonth(month: number, delta: number): number {
  const date = new Date(month);
  return new Date(date.getFullYear(), date.getMonth() + delta, 1, 12).getTime();
}
