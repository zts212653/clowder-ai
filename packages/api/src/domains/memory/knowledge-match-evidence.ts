import type { EvidenceItem } from './interfaces.js';

// Shared indexed-field provenance; it does not grant authority or rank truth.
const SEARCH_STOPWORDS = new Set([
  'anchor',
  'anchors',
  'and',
  'doc',
  'docs',
  'document',
  'documents',
  'feature',
  'features',
  'graph',
  'graphs',
  'node',
  'nodes',
  'query',
  'search',
  'such',
  'the',
]);

type MatchReason = 'anchor' | 'title' | 'source' | 'summary' | 'keyword' | 'content';

function includesIgnoreCase(value: string | undefined, query: string): boolean {
  return value?.toLowerCase().includes(query) ?? false;
}

function queryTokens(query: string): string[] {
  const tokens = new Set<string>();
  for (const token of query.toLowerCase().match(/[a-z0-9]+/g) ?? []) {
    if (token.length < 3 || /^\d+$/.test(token) || SEARCH_STOPWORDS.has(token)) continue;
    tokens.add(token);
  }
  for (const run of query.match(/\p{Script=Han}+/gu) ?? []) {
    if (run.length < 2) continue;
    tokens.add(run);
    for (let index = 0; index < run.length - 1; index += 1) tokens.add(run.slice(index, index + 2));
    for (let index = 0; index < run.length - 2; index += 1) tokens.add(run.slice(index, index + 3));
  }
  return [...tokens];
}

function candidateSearchText(item: EvidenceItem): string {
  return [
    item.anchor,
    item.title,
    item.sourcePath,
    item.summary,
    ...(item.keywords ?? []),
    ...(item.passages ?? []).flatMap((passage) => [
      passage.content,
      ...(passage.context ?? []).map((contextPassage) => contextPassage.content),
    ]),
  ]
    .filter((value): value is string => Boolean(value))
    .join('\n')
    .toLowerCase();
}

export function hasIndexedMatchEvidence(item: EvidenceItem, query: string): boolean {
  const q = query.toLowerCase();
  if (
    includesIgnoreCase(item.anchor, q) ||
    includesIgnoreCase(item.title, q) ||
    includesIgnoreCase(item.sourcePath, q) ||
    includesIgnoreCase(item.summary, q) ||
    item.passages?.some(
      (passage) =>
        includesIgnoreCase(passage.content, q) ||
        passage.context?.some((contextPassage) => includesIgnoreCase(contextPassage.content, q)),
    ) ||
    item.keywords?.some((keyword) => includesIgnoreCase(keyword, q))
  )
    return true;
  const searchText = candidateSearchText(item);
  return queryTokens(query).some((token) => searchText.includes(token));
}

export const TEXT_MATCH_SCORES: Record<MatchReason, number> = {
  anchor: 10,
  title: 6,
  source: 3,
  summary: 3,
  keyword: 3,
  content: 1,
};

function truncateSnippet(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const text = value.replace(/\s+/g, ' ').trim();
  if (text.length <= 160) return text;
  return `${text.slice(0, 157)}...`;
}

export function classifyIndexedMatch(
  item: EvidenceItem,
  query: string,
): { matchReason: MatchReason; snippet?: string } {
  const q = query.toLowerCase();
  if (includesIgnoreCase(item.anchor, q)) return { matchReason: 'anchor', snippet: item.anchor };
  if (item.anchor) {
    const anchorLower = item.anchor.toLowerCase();
    const queryWords = q.match(/[a-z0-9]+/g) ?? [];
    if (queryWords.some((w) => w === anchorLower)) return { matchReason: 'anchor', snippet: item.anchor };
  }
  if (includesIgnoreCase(item.title, q)) return { matchReason: 'title', snippet: item.title };
  if (includesIgnoreCase(item.sourcePath, q)) return { matchReason: 'source', snippet: item.sourcePath };
  if (includesIgnoreCase(item.summary, q)) return { matchReason: 'summary', snippet: truncateSnippet(item.summary) };
  const keyword = item.keywords?.find((k) => includesIgnoreCase(k, q));
  if (keyword) return { matchReason: 'keyword', snippet: keyword };
  return { matchReason: 'content', snippet: truncateSnippet(item.summary) ?? item.title };
}
