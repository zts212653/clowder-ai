import type { StoredEventMemory } from '@cat-cafe/shared';

export interface BrakeMessage {
  key: string;
  sourceEventId: string;
  threadId: string;
  messageId: string;
  timestamp: number;
  summary: string;
  words: string[];
  cats: string[];
  rules: string[];
}

/** Show the recorded sentences around the first brake word; keep the full quote in the detail. */
export function brakeExcerpt(summary: string, words: readonly string[]): string {
  const sentences = summary
    .split(/(?<=[。！？.!?])|\n+/)
    .map((s) => s.trim())
    .filter(Boolean);
  const match = sentences.findIndex((sentence) => words.some((word) => sentence.includes(word)));
  if (match < 0) return summary;
  const start = Math.max(0, match - 1);
  const end = Math.min(sentences.length, match + 2);
  const quote = sentences.slice(start, end).join('');
  const wordAt = Math.min(...words.map((word) => quote.indexOf(word)).filter((index) => index >= 0));
  const clipStart = Math.max(0, wordAt - 48);
  const clipEnd = Math.min(quote.length, wordAt + 120);
  return `${start > 0 || clipStart > 0 ? '…' : ''}${quote.slice(clipStart, clipEnd)}${end < sentences.length || clipEnd < quote.length ? '…' : ''}`;
}

export function groupHumanBrakes(events: readonly StoredEventMemory[]): BrakeMessage[] {
  const groups = new Map<string, BrakeMessage>();
  const seen = new Set<string>();
  for (const event of events) {
    // Low confidence is a word mention/quotation, not a verified human intervention.
    if (event.trigger !== 'human_brake' || event.confidence === 'low' || seen.has(event.eventId)) continue;
    seen.add(event.eventId);
    const key = event.threadId && event.messageId ? JSON.stringify([event.threadId, event.messageId]) : event.eventId;
    let row = groups.get(key);
    if (!row) {
      row = {
        key,
        sourceEventId: event.eventId,
        threadId: event.threadId,
        messageId: event.messageId,
        timestamp: event.timestamp,
        summary: event.summary,
        words: [],
        cats: [],
        rules: [],
      };
      groups.set(key, row);
    }
    row.words = [...new Set([...row.words, event.type])];
    row.cats = [...new Set([...row.cats, event.cat])];
    row.rules = [...new Set([...row.rules, ...(event.relatedHarness ?? [])])];
    if (event.summary.length > row.summary.length) row.summary = event.summary;
    row.timestamp = Math.max(row.timestamp, event.timestamp);
  }
  return [...groups.values()].sort((a, b) => b.timestamp - a.timestamp);
}
