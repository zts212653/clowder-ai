const QUOTE_PAIRS = [
  ['"', '"'],
  ["'", "'"],
  ['“', '”'],
  ['‘', '’'],
  ['「', '」'],
  ['『', '』'],
] as const;

export function tasteQuote(value: string): string {
  let text = value.trim();
  while (text.length >= 2) {
    const pair = QUOTE_PAIRS.find(([start, end]) => text.startsWith(start) && text.endsWith(end));
    if (!pair) break;
    text = text.slice(1, -1).trim();
  }
  return `“${text}”`;
}

/** Timestamp instants follow the viewer's local zone; date-only records are never shifted. */
export function tasteTime(at: number, timeZone?: string, now = new Date()): string {
  const formatter = new Intl.DateTimeFormat('zh-CN', {
    timeZone,
    year: 'numeric',
    month: 'numeric',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  });
  const parts = Object.fromEntries(formatter.formatToParts(new Date(at)).map((part) => [part.type, part.value]));
  const currentYear = formatter.formatToParts(now).find((part) => part.type === 'year')?.value;
  return `${parts.year === currentYear ? '' : `${parts.year}年`}${parts.month}月${parts.day}日 ${parts.hour}:${parts.minute}`;
}

export function tasteRecordedDate(value: string): string {
  const parts = /^(\d{4})-(\d{2})(?:-(\d{2}))?$/.exec(value);
  if (!parts) return value;
  const year = Number(parts[1]);
  return `${year === new Date().getFullYear() ? '' : `${year}年`}${Number(parts[2])}月${parts[3] ? `${Number(parts[3])}日` : ''}`;
}
