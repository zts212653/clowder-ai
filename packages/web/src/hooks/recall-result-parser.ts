import {
  parseRecallMetaFromText,
  type RecallMatchRank,
  type RecallMatchType,
  type RecallPreviewItem,
} from '@cat-cafe/shared';
import type { RecallEvent, RecallResultItem } from './recall-types';

const UNKNOWN_QUERY = '(unknown)';

export function parseRecallToolInput(detail?: string): {
  query?: string;
  q?: string;
  anchor?: string;
  mode?: string;
  scope?: string;
} {
  if (!detail) return {};
  try {
    return JSON.parse(detail) as { query?: string; q?: string; anchor?: string; mode?: string; scope?: string };
  } catch {
    return {};
  }
}

function parseResultCountFromText(text: string): number | undefined {
  const match = text.match(/^(?:Evidence search results:\s*)?Found (\d+) result\(s\)(?::|\s|$)/m);
  return match ? Number.parseInt(match[1], 10) : undefined;
}

function parseJsonStringLiteral(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  try {
    const parsed = JSON.parse(raw);
    return typeof parsed === 'string' ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function parseJsonStringPrefix(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  return parseJsonStringLiteral(`"${raw.replace(/…$/, '')}"`);
}

interface ResultQueryMatch {
  query: string;
  kind: 'exact' | 'prefix';
}

export function parseResultQueryFromText(text: string): ResultQueryMatch | undefined {
  const foundMatch = text.match(
    /^(?:Evidence search results:\s*)?Found \d+ result\(s\) for ("(?:\\.|[^"\\])*")(?:\s+\[[^\]\n]+\])?:?/m,
  );
  const foundQuery = parseJsonStringLiteral(foundMatch?.[1]);
  if (foundQuery != null) return { query: foundQuery, kind: 'exact' };

  const foundPrefixMatch = text.match(/^(?:Evidence search results:\s*)?Found \d+ result\(s\) for "((?:\\.|[^"\\])*)/m);
  const foundQueryPrefix = parseJsonStringPrefix(foundPrefixMatch?.[1]);
  if (foundQueryPrefix) return { query: foundQueryPrefix, kind: 'prefix' };

  const errorMatch = text.match(/(?:^|\n)Evidence search (?:request )?failed for ("(?:\\.|[^"\\])*")(?: \(\d+\))?:?/m);
  const errorQuery = parseJsonStringLiteral(errorMatch?.[1]);
  if (errorQuery != null) return { query: errorQuery, kind: 'exact' };

  const errorPrefixMatch = text.match(/(?:^|\n)Evidence search (?:request )?failed for "((?:\\.|[^"\\])*)/m);
  const errorQueryPrefix = parseJsonStringPrefix(errorPrefixMatch?.[1]);
  if (errorQueryPrefix) return { query: errorQueryPrefix, kind: 'prefix' };

  const noResultMatch = text.match(/(?:^|\n)(?:Evidence search results:\s*)?No results found for:\s*(.+)$/m);
  const noResultQuery = noResultMatch?.[1]?.trim();
  if (!noResultQuery) return undefined;
  if (noResultQuery.endsWith('…')) {
    return { query: noResultQuery.replace(/…$/, ''), kind: 'prefix' };
  }
  return { query: noResultQuery, kind: 'exact' };
}

function hasEvidenceResultMarker(text: string): boolean {
  return /(?:^|\n)Evidence search results:/m.test(text);
}

function hasLegacyEvidenceMetadata(text: string): boolean {
  return [/(?:^|\n)\s+(?:anchor|type):\s+.+/m, /(?:^|\n)📊 本轮第 /m].some((pattern) => pattern.test(text));
}

export function isSearchEvidenceResultText(text: string): boolean {
  const hasResultMarker = hasEvidenceResultMarker(text);
  const hasResultCount = parseResultCountFromText(text) != null;
  const hasNoResult = /(?:^|\n)(?:Evidence search results:\s*)?No results found for:/m.test(text);
  const hasEvidenceError = [
    /(?:^|\n)Evidence search (?:request )?failed(?: for "(?:\\.|[^"\\])*")?(?: \(\d+\))?:?/m,
    /(?:^|\n)Evidence search (?:request )?failed for "(?:\\.|[^"\\])*/m,
  ].some((pattern) => pattern.test(text));

  if (hasEvidenceError) return true;
  if (hasResultMarker) {
    if (hasResultCount) return true;
    return hasNoResult;
  }
  if (!hasResultCount) return false;
  return hasLegacyEvidenceMetadata(text);
}

function isUnknownCountEvidenceFailure(text: string): boolean {
  return /result exceeds maximum allowed tokens|maximum allowed tokens|Full result saved to|saved to .*\.txt/i.test(
    text,
  );
}

export function findPendingSearchIndex(
  pendingSearches: RecallEvent[],
  resultQuery: ResultQueryMatch | undefined,
): number {
  if (resultQuery == null) return 0;

  let pendingIndex = -1;
  if (resultQuery.kind === 'exact') {
    pendingIndex = pendingSearches.findIndex((recall) => recall.query === resultQuery.query);
  } else {
    const prefixMatches = pendingSearches
      .map((recall, index) => ({ recall, index }))
      .filter(({ recall }) => recall.query.startsWith(resultQuery.query));
    pendingIndex = prefixMatches.length === 1 ? prefixMatches[0].index : -1;
  }

  if (pendingIndex >= 0) return pendingIndex;

  return pendingSearches.findIndex((recall) => recall.query === UNKNOWN_QUERY);
}

export function applyResultToRecall(recall: RecallEvent, text: string, resultQuery?: ResultQueryMatch): void {
  if (recall.query === UNKNOWN_QUERY && resultQuery?.kind === 'exact') {
    recall.query = resultQuery.query;
  }
  const meta = parseRecallMetaFromText(text);
  const hasStructuredMeta = meta != null;
  if (meta) {
    recall.resultStatus = meta.resultStatus;
    if (typeof meta.resultCount === 'number') {
      recall.resultCount = meta.resultCount;
    }
  }
  const resultCount = parseResultCountFromText(text);
  if (!hasStructuredMeta && recall.resultCount == null && resultCount != null) {
    recall.resultCount = resultCount;
  } else if (
    !hasStructuredMeta &&
    recall.resultCount == null &&
    !isUnknownCountEvidenceFailure(text) &&
    /No results found/.test(text)
  ) {
    recall.resultCount = 0;
  }
  const textResults = parseTextResults(text);
  recall.results = textResults.length > 0 ? textResults : recallPreviewItemsToResults(meta?.previewItems);
  if (!recall.resultStatus) {
    recall.resultStatus =
      recall.resultCount === 0 ? 'no_results' : recall.resultCount != null ? 'counted' : 'legacy_unknown';
  }
}

function recallPreviewItemsToResults(items: RecallPreviewItem[] | undefined): RecallResultItem[] {
  if (!items) return [];
  return items.flatMap((item) => {
    if (!item.title) return [];
    return [
      {
        title: item.title,
        ...(item.matchRank ? { matchRank: item.matchRank } : {}),
        ...(item.matchType ? { matchType: item.matchType } : {}),
        ...(item.authority ? { authority: item.authority } : {}),
        ...(item.updatedAt ? { updatedAt: item.updatedAt } : {}),
        ...(item.anchor ? { anchor: item.anchor } : {}),
        ...(item.snippet ? { snippet: item.snippet } : {}),
      },
    ];
  });
}

/**
 * Pure: parse structured results from plain text output of evidence-tools.ts.
 * Ranked format: "[match:<rank> · authority:<tier> · updated:<timestamp>] title".
 * Coverage format: "[matchType:<relation>] title". Historical bracket-only
 * rank and coverage lines remain readable through separate, closed unions.
 * Exported for testing.
 */
export function parseTextResults(text: string): RecallResultItem[] {
  if (!text) return [];
  const results: RecallResultItem[] = [];
  const lines = text.split('\n');

  for (let i = 0; i < lines.length; i++) {
    const current = lines[i].match(/^\[match:(high|mid|low) · authority:([^\]]+?) · updated:([^\]]+?)\]\s+(.+)$/);
    const coverage = lines[i].match(/^\[matchType:(direct|alias|source-thread|convention)\]\s+(.+)$/);
    const legacyRank = lines[i].match(/^\[(high|mid|low)\]\s+(.+)$/);
    const legacyCoverage = lines[i].match(/^\[(direct|alias|source-thread|convention)\]\s+(.+)$/);
    if (!current && !coverage && !legacyRank && !legacyCoverage) continue;

    const item: RecallResultItem = {
      ...(current || legacyRank ? { matchRank: (current?.[1] ?? legacyRank?.[1]) as RecallMatchRank } : {}),
      ...(coverage || legacyCoverage ? { matchType: (coverage?.[1] ?? legacyCoverage?.[1]) as RecallMatchType } : {}),
      title: current?.[4] ?? coverage?.[2] ?? legacyRank?.[2] ?? legacyCoverage?.[2] ?? '',
      ...(current ? { authority: current[2], updatedAt: current[3] } : {}),
    };

    // Look ahead for metadata on subsequent indented lines
    for (let j = i + 1; j < lines.length && lines[j].startsWith('  '); j++) {
      const anchorMatch = lines[j].match(/^\s+anchor:\s+(.+)$/);
      if (anchorMatch) {
        item.anchor = anchorMatch[1];
        continue;
      }
      const typeMatch = lines[j].match(/^\s+type:\s+(.+)$/);
      if (typeMatch) {
        item.sourceType = typeMatch[1];
        continue;
      }
      const snippetMatch = lines[j].match(/^\s+>\s+(.+)$/);
      if (snippetMatch) {
        item.snippet = snippetMatch[1];
      }
    }

    results.push(item);
  }

  return results;
}
