import type { EntrustedWorkOwnerReadV1 } from '@cat-cafe/shared';

export const WORK_STATUS = { todo: '待开始', doing: '进行中', blocked: '已阻塞', done: '已完成' } as const;
export const WORK_TIME = {
  business_deadline: '截止',
  review_by: '请你审阅',
  execution_trigger: '执行时间',
  planned_start: '计划开始',
  actual_start: '实际开始',
  estimated_completion: '预计完成',
  admitted_at: '接单日期',
  completed_at: '完成',
} as const;

/** Full current owner reads, deduplicated by canonical Work identity before personal filtering. */
const STATE_ORDER = { blocked: 0, doing: 1, todo: 2, done: 3 } as const;
export function currentScheduleWorks(reads: EntrustedWorkOwnerReadV1[]) {
  const unique = new Map<string, EntrustedWorkOwnerReadV1>();
  for (const work of reads) {
    if (work.envelope.freshness.state !== 'current') continue;
    const previous = unique.get(work.envelope.subjectRef);
    if (!previous || previous.envelope.revision < work.envelope.revision) unique.set(work.envelope.subjectRef, work);
  }
  return [...unique.values()].sort(
    (a, b) =>
      STATE_ORDER[a.brief.current.state] - STATE_ORDER[b.brief.current.state] ||
      Math.min(...workDates(a).map((time) => time.value)) - Math.min(...workDates(b).map((time) => time.value)),
  );
}

export function calendarDateKey(value: number): string {
  const date = new Date(value);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

export function workDates(work: EntrustedWorkOwnerReadV1) {
  // Runtime wakeups are not business appointments or promised delivery dates.
  return work.timeRefs.filter(
    (time): time is typeof time & { role: Exclude<typeof time.role, 'execution_trigger'> } =>
      time.role !== 'execution_trigger',
  );
}

export function workTitle(work: EntrustedWorkOwnerReadV1): string {
  if (work.work) return work.work.title;
  return work.brief.outcome.state === 'known' ? work.brief.outcome.value : '待补充工作目标';
}

/** Date markers from existing Task facts; never written back as business dates. */
export function workCalendarDates(
  work: EntrustedWorkOwnerReadV1,
): Array<EntrustedWorkOwnerReadV1['timeRefs'][number] & { role: 'actual_start' | 'business_deadline' }> {
  return work.timeRefs.filter(
    (time): time is typeof time & { role: 'actual_start' | 'business_deadline' } =>
      time.role === 'actual_start' || time.role === 'business_deadline',
  );
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
