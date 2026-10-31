import type { TasteMemory } from './taste-types';

const QUOTE_PAIRS = [
  ['"', '"'],
  ["'", "'"],
  ['“', '”'],
  ['‘', '’'],
  ['「', '」'],
  ['『', '』'],
] as const;

function leadingQuoteEnd(text: string, start: string, end: string): number {
  if (text.endsWith(end)) return text.length - 1;
  if (start === end) return text.indexOf(end, 1);
  let depth = 1;
  for (let i = 1; i < text.length; i++) {
    if (text[i] === start) depth++;
    if (text[i] === end && --depth === 0) return i;
  }
  return -1;
}

export function tasteQuote(value: string): string {
  let text = value.trim();
  while (text.length >= 2) {
    const pair = QUOTE_PAIRS.find(([start]) => text.startsWith(start));
    if (!pair) break;
    const end = leadingQuoteEnd(text, pair[0], pair[1]);
    if (end < 0) break;
    text = (text.slice(1, end) + text.slice(end + 1)).trim();
  }
  return `“${text}”`;
}

export function currentTakeawayCandidate(entry: Pick<TasteMemory, 'revision' | 'takeawayCandidate'>) {
  return entry.takeawayCandidate?.basedOnRevision === entry.revision ? entry.takeawayCandidate : null;
}
export function tasteCardLead(
  entry: Pick<TasteMemory, 'takeaway' | 'title' | 'quotes' | 'revision' | 'takeawayCandidate'>,
): string {
  return (
    currentTakeawayCandidate(entry)?.takeaway ||
    entry.takeaway ||
    (entry.quotes[0] ? tasteQuote(entry.quotes[0]) : entry.title)
  );
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
  return `${parts.year === currentYear ? '' : `${parts.year} 年 `}${parts.month} 月 ${parts.day} 日 ${parts.hour}:${parts.minute}`;
}

export { memoryDate as tasteRecordedDate } from './memory-time';
