import type { CollectiveTimeFact, CollectiveWorkProjection, CollectiveWorkTimeField } from '@cat-cafe/shared';

export const workTimeLabels: Record<CollectiveWorkTimeField, readonly [string, string]> = {
  businessDeadline: ['截止', 'Deadline'],
  reviewBy: ['请你审阅', 'Review by'],
  plannedStart: ['计划开始', 'Planned start'],
  actualStart: ['实际开始', 'Started'],
  estimatedCompletion: ['预计完成', 'Estimated completion'],
};

export function formatWorkDate(fact: Pick<CollectiveTimeFact, 'value' | 'timeZone'>, language: 'zh' | 'en') {
  return new Intl.DateTimeFormat(language === 'en' ? 'en-US' : 'zh-CN', {
    month: '2-digit',
    day: '2-digit',
    weekday: 'short',
    timeZone: fact.timeZone,
  }).format(new Date(fact.value));
}

export function formatWorkDateTime(fact: Pick<CollectiveTimeFact, 'value' | 'timeZone'>, language: 'zh' | 'en') {
  return new Intl.DateTimeFormat(language === 'en' ? 'en-US' : 'zh-CN', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    timeZone: fact.timeZone,
  }).format(new Date(fact.value));
}

export function workTimePresentation(work: CollectiveWorkProjection, language: 'zh' | 'en', now = Date.now()) {
  const time = work.time;
  for (const field of ['businessDeadline', 'reviewBy', 'estimatedCompletion'] as const) {
    const fact = time?.[field];
    if (!fact) continue;
    const overdue =
      field === 'businessDeadline' &&
      !['completed', 'cancelled', 'declined'].includes(work.lifecycle) &&
      Date.parse(fact.value) < now;
    const days = Math.max(1, Math.floor((now - Date.parse(fact.value)) / 86_400_000));
    return {
      field,
      fact,
      tone: overdue ? 'overdue' : field === 'estimatedCompletion' ? 'estimate' : 'date',
      label: overdue
        ? language === 'en'
          ? `${days} day${days === 1 ? '' : 's'} overdue`
          : `超过截止 ${days} 天`
        : workTimeLabels[field][language === 'en' ? 1 : 0],
      date: formatWorkDate(fact, language),
    };
  }
  return undefined;
}

export function projectLatestDeadline(works: readonly CollectiveWorkProjection[]) {
  return works
    .map((work) => work.time?.businessDeadline)
    .filter((value): value is CollectiveTimeFact => Boolean(value))
    .sort((left, right) => Date.parse(right.value) - Date.parse(left.value))[0];
}

function localParts(instant: number, timeZone: string) {
  const values = Object.fromEntries(
    new Intl.DateTimeFormat('en-CA', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    })
      .formatToParts(instant)
      .filter((part) => part.type !== 'literal')
      .map((part) => [part.type, part.value]),
  );
  return `${values.year}-${values.month}-${values.day}T${values.hour}:${values.minute}`;
}

export function timeFactToLocalDateTime(fact: Pick<CollectiveTimeFact, 'value' | 'timeZone'>) {
  return localParts(Date.parse(fact.value), fact.timeZone);
}

/** All actual instants for this wall clock. Clock changes can leave zero or two choices. */
export function localDateTimeInstants(value: string, timeZone: string): string[] {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(value)) throw new Error('请选择日期和时间 / Choose a date and time');
  const target = Date.parse(`${value}:00Z`);
  if (!Number.isFinite(target)) return [];
  const candidates = new Set<string>();
  // Observe offsets on both sides of a transition, including half-hour shifts.
  for (const hours of [-36, -12, 0, 12, 36]) {
    const sample = target + hours * 3_600_000;
    const offset = Date.parse(`${localParts(sample, timeZone)}:00Z`) - sample;
    const instant = target - offset;
    if (localParts(instant, timeZone) === value) candidates.add(new Date(instant).toISOString());
  }
  return [...candidates].sort();
}

/** Interpret a named-zone wall clock; a repeated hour requires a person to choose its occurrence. */
export function localDateTimeToInstant(value: string, timeZone: string, selectedInstant?: string): string {
  const candidates = localDateTimeInstants(value, timeZone);
  if (candidates.length === 0)
    throw new Error('这个时区没有该本地时间 / This local time does not exist in the selected time zone');
  if (candidates.length === 1) return candidates[0]!;
  const selected = selectedInstant && new Date(selectedInstant).toISOString();
  if (selected && candidates.includes(selected)) return selected;
  throw new Error('这个时间重复出现，请选具体哪一次 / This local time occurs twice; choose its occurrence');
}
