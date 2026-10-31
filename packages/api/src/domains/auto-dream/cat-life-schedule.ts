import { createHash } from 'node:crypto';
import type { CatLifeSettingsInput } from '@cat-cafe/shared';
import { computeNextCronSlot } from '../../infrastructure/scheduler/cron-utils.js';
import type { CatLifeDerivedValue } from './store-types.js';

const WEEKDAY_NUMBERS = {
  sun: 0,
  mon: 1,
  tue: 2,
  wed: 3,
  thu: 4,
  fri: 5,
  sat: 6,
} as const;

export function deriveCatLifeSchedule(settings: CatLifeSettingsInput, now: number): CatLifeDerivedValue {
  validateTimezone(settings.timezone);
  validateQuietHours(settings);
  const [hour, minute] = settings.wakeTime.split(':').map(Number);
  const weekdays = resolveWeekdays(settings);
  const dayExpression = weekdays.length === 7 ? '*' : weekdays.join(',');
  const cronExpression = `${minute} ${hour} * * ${dayExpression}`;
  const weeklyWakeCount = settings.enabled ? weekdays.length : 0;
  const costBand = weeklyWakeCount <= 3 ? 'low' : weeklyWakeCount <= 5 ? 'medium' : 'high';
  return {
    cronExpression,
    nextWakeAt: settings.enabled ? computeNextCronSlot(cronExpression, settings.timezone, now, undefined) : null,
    weeklyWakeCount,
    costBand,
    costNotice: settings.enabled
      ? `每周约 ${weeklyWakeCount} 次唤醒；每次都可能调用模型，请按猫粮预算调整。`
      : '当前已暂停，不会产生模型唤醒；恢复后按所选节奏运行。',
  };
}

export function catLifeProjectionTaskId(ownerUserId: string, catId: string): string {
  return `f255-present-loop-${stableSuffix(ownerUserId, catId, 'present-loop')}`;
}

export function catLifeBedroomThreadId(ownerUserId: string, catId: string): string {
  return `thread-f255-bedroom-${stableSuffix(ownerUserId, catId, 'bedroom')}`;
}

function resolveWeekdays(settings: CatLifeSettingsInput): number[] {
  switch (settings.rhythm.kind) {
    case 'gentle':
      return [1, 3, 5];
    case 'daily':
      return [0, 1, 2, 3, 4, 5, 6];
    case 'weekends':
      return [0, 6];
    case 'custom':
      return [...new Set(settings.rhythm.weekdays.map((day) => WEEKDAY_NUMBERS[day]))].sort((a, b) => a - b);
  }
}

function validateTimezone(timezone: string): void {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: timezone }).format(0);
  } catch {
    throw new Error(`Invalid IANA timezone "${timezone}". Example: America/Los_Angeles`);
  }
}

function validateQuietHours(settings: CatLifeSettingsInput): void {
  if (!settings.quietHours) return;
  const wake = minutes(settings.wakeTime);
  const start = minutes(settings.quietHours.start);
  const end = minutes(settings.quietHours.end);
  if (start === end) throw new Error('quiet hours start and end must differ');
  const inside = start < end ? wake >= start && wake < end : wake >= start || wake < end;
  if (inside) {
    throw new Error(
      `wakeTime ${settings.wakeTime} falls inside quiet hours ${settings.quietHours.start}-${settings.quietHours.end}`,
    );
  }
}

function minutes(value: string): number {
  const [hour, minute] = value.split(':').map(Number);
  return hour * 60 + minute;
}

function stableSuffix(ownerUserId: string, catId: string, purpose: string): string {
  return createHash('sha256').update(`${ownerUserId}\0${catId}\0${purpose}`).digest('hex').slice(0, 24);
}
