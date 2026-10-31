export function householdLocalDateAt(epochMs: number, timeZone: string): string {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(epochMs);
  const values = new Map(parts.map((part) => [part.type, part.value]));
  return `${values.get('year')}-${values.get('month')}-${values.get('day')}`;
}

export function quietHoursActiveAt(
  epochMs: number,
  timeZone: string,
  quietHours: { start: string; end: string } | undefined,
): boolean {
  if (!quietHours) return false;
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(epochMs);
  const values = new Map(parts.map((part) => [part.type, part.value]));
  const current = Number(values.get('hour')) * 60 + Number(values.get('minute'));
  const start = minutes(quietHours.start);
  const end = minutes(quietHours.end);
  return start < end ? current >= start && current < end : current >= start || current < end;
}

function minutes(value: string): number {
  const [hour, minute] = value.split(':').map(Number);
  return hour * 60 + minute;
}
