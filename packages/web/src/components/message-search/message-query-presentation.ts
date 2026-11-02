import type { MessageSearchResult } from '@cat-cafe/shared';

type Decision = NonNullable<MessageSearchResult['decisionSources']>[number];
const terms = (query: string) => [...new Set(query.trim().split(/\s+/u).filter(Boolean))];
const escapeLiteral = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** This filters already-admitted decision metadata, never the message search or its qualification. */
export function matchingDecisionSources(result: MessageSearchResult, query: string): Decision[] {
  const words = terms(query);
  if (!words.length) return [];
  return (result.decisionSources ?? []).filter(
    (fact) => !fact.historical && words.every((word) => new RegExp(escapeLiteral(word), 'iu').test(fact.conclusion)),
  );
}

/** Literal highlighting in fresh text. Coordinates belong to that text, never a stale snippet revision. */
export function queryMatchRanges(text: string, query: string): Array<{ start: number; end: number }> {
  const words = terms(query).sort((a, b) => b.length - a.length);
  if (!words.length) return [];
  return [...text.matchAll(new RegExp(words.map(escapeLiteral).join('|'), 'giu'))].map((match) => ({
    start: match.index,
    end: match.index + match[0].length,
  }));
}

/** Re-find the exact excerpt in the fresh body; a saved body offset is not valid after an edit. */
export function excerptHitOffset(text: string, result: MessageSearchResult): number | undefined {
  const snippet = result.snippet.text;
  const range = result.highlights.find(
    (item) =>
      Number.isInteger(item.start) &&
      Number.isInteger(item.end) &&
      item.start >= 0 &&
      item.end > item.start &&
      item.end <= snippet.length,
  );
  if (!range) return;
  const start = text.indexOf(snippet);
  if (start < 0 || start !== text.lastIndexOf(snippet)) return;
  return start + range.start;
}
