import type { MessageSearchResult } from '@cat-cafe/shared';
import { extractStandalonePawFeelMarkers } from '../../infrastructure/harness-eval/friction/paw-feel-marker.js';

const BUDGET = 240;
type Anchor = { start: number; end: number };
type Hit = Anchor & { key: number };
type Terms = { pattern: RegExp; key: (word: string) => number };

const escaped = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function queryTerms(query: string): Terms | null {
  const terms = [
    ...new Map(
      query
        .trim()
        .split(/\s+/u)
        .filter(Boolean)
        .map((term) => [term.toLocaleLowerCase(), term]),
    ).values(),
  ].sort((a, b) => b.length - a.length);
  if (!terms.length) return null;
  const keys = new Map(terms.map((term, i) => [term.toLocaleLowerCase(), i]));
  const exact = terms.map((term) => new RegExp(`^${escaped(term)}$`, 'iu'));
  return {
    pattern: new RegExp(terms.map(escaped).join('|'), 'giu'),
    key: (word: string) => keys.get(word.toLocaleLowerCase()) ?? exact.findIndex((term) => term.test(word)),
  };
}

/** Pick an original-text span; recall ranking and cat selection stay elsewhere. */
function queryAnchor(text: string, query: string): Anchor {
  // An intentional tool report is an annotation on this message. Prefer a
  // matching original body over a query repeated in that annotation. Reports
  // remain available when explicitly requested, or when the body has no hit.
  const reports = extractStandalonePawFeelMarkers(text);
  // Tool identifiers may be wrapped in Markdown or followed by label/sentence
  // punctuation. Internal identifier punctuation and suffixes stay significant.
  const queryWords = new Set(
    [...query.toLocaleLowerCase().matchAll(/(?<![\w.:-])[a-z][\w.:-]*/g)].flatMap((word) => [
      word[0],
      word[0].replace(/[.:]+$/, ''),
    ]),
  );
  const requestedTools = [
    ...new Set(
      reports.flatMap((report) =>
        report.tool && queryWords.has(report.tool.toLocaleLowerCase()) ? [report.tool] : [],
      ),
    ),
  ];
  const requestedReport = query.includes('爪感差') || requestedTools.length > 0;
  if (reports.length && !requestedReport) {
    let cursor = 0;
    let primary = '';
    for (const report of reports) {
      primary += text.slice(cursor, report.sourceIndex) + ' '.repeat(report.raw.length);
      cursor = report.sourceIndex + report.raw.length;
    }
    primary += text.slice(cursor);
    const anchor = literalAnchor(primary, query);
    if (anchor.end > anchor.start) return anchor;
  }
  return literalAnchor(text, query, requestedTools);
}

function literalAnchor(text: string, query: string, identifiers: string[] = []): Anchor {
  const phrase = query.trim();
  const exact = phrase
    ? (new RegExp(escaped(phrase), 'u').exec(text) ?? new RegExp(escaped(phrase), 'iu').exec(text))
    : null;
  if (exact) return { start: exact.index, end: exact.index + exact[0].length };
  const terms = queryTerms(identifiers.length ? `${query} ${identifiers.join(' ')}` : query);
  return terms ? wordAnchor(text, terms) : { start: 0, end: 0 };
}

function wordAnchor(text: string, terms: Terms): Anchor {
  // Retain at most one 240-unit window of hits, rather than a body-sized hit list.
  const active: Hit[] = [];
  const counts = new Map<number, number>();
  const discardOldest = () => {
    // Both callers prove the active window is nonempty.
    const old = active[0];
    active.shift();
    const left = (counts.get(old.key) ?? 0) - 1;
    if (left > 0) counts.set(old.key, left);
    else counts.delete(old.key);
  };
  let best: Anchor = { start: 0, end: 0 };
  let bestCount = 0;
  let bestWidth = Infinity;
  for (const match of text.matchAll(terms.pattern)) {
    const hit = { start: match.index, end: match.index + match[0].length, key: terms.key(match[0]) };
    if (hit.end - hit.start > BUDGET) continue;
    while (active.length && active[0].start < hit.end - BUDGET) {
      discardOldest();
    }
    active.push(hit);
    counts.set(hit.key, (counts.get(hit.key) ?? 0) + 1);
    // Repeated opening words need not dilute a later compact multiword window.
    while (active.length > 1 && (counts.get(active[0].key) ?? 0) > 1) {
      discardOldest();
    }
    const start = active[0].start;
    const width = hit.end - start;
    if (counts.size > bestCount || (counts.size === bestCount && width < bestWidth)) {
      best = { start, end: hit.end };
      bestCount = counts.size;
      bestWidth = width;
    }
  }
  return best;
}

function boundedEnd(text: string, start: number, requiredEnd: number): number {
  let end = Math.min(text.length, start + BUDGET);
  // Offsets remain UTF-16, while a valid source pair must not be cut in half.
  if (end < text.length && /[\uD800-\uDBFF]/u.test(text[end - 1]) && /[\uDC00-\uDFFF]/u.test(text[end])) end--;
  const window = text.slice(start, end);
  let previous = 0;
  let sentences = 0;
  // Paragraph separators are not sentences: several introductory lines must
  // not consume the prose budget before the first actual sentence appears.
  for (const boundary of window.matchAll(/[。！？]+|[.!?]+(?=\s|$)/gu)) {
    const boundaryEnd = boundary.index + boundary[0].length;
    if (window.slice(previous, boundary.index).trim()) {
      sentences++;
      if (sentences >= 2 && start + boundaryEnd >= requiredEnd) return start + boundaryEnd;
    }
    previous = boundaryEnd;
  }
  return end;
}

export function projectMessageSearchSnippet(
  text: string,
  source: MessageSearchResult['snippet']['source'],
  query = '',
): MessageSearchResult['snippet'] {
  // Flattened attachment text does not prove which publisher owns a report.
  const anchor = source === 'body' ? queryAnchor(text, query) : literalAnchor(text, query);
  const width = anchor.end - anchor.start;
  let start =
    anchor.start <= 160 && anchor.end <= BUDGET
      ? 0
      : Math.max(0, anchor.start - Math.min(80, Math.max(0, BUDGET - width)));
  if (start > 0 && /[\uDC00-\uDFFF]/u.test(text[start]) && /[\uD800-\uDBFF]/u.test(text[start - 1])) start++;
  const end = boundedEnd(text, start, anchor.end);
  return { text: text.slice(start, end), start, end, source };
}

export function projectMessageSearchHighlights(text: string, query: string): MessageSearchResult['highlights'] {
  const terms = queryTerms(query);
  if (!terms) return [];
  // Preserve the existing response/snapshot schema's 200-range ceiling.
  return [...text.matchAll(terms.pattern)]
    .slice(0, 200)
    .map((match) => ({ start: match.index, end: match.index + match[0].length }));
}
