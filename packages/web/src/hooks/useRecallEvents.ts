/**
 * F102 Phase J: Hook + pure helpers for extracting search_evidence ToolEvents
 * from the current invocation's event stream.
 *
 * Production data shapes:
 * - tool_use.label = "${catId} → ${toolName}" (e.g. "opus → search_evidence")
 * - tool_result.label = "${catId} ← result" (generic, no tool name)
 * - tool_result.detail = plain text from evidence-tools.ts, truncated by compactToolResultDetail
 */

import { useMemo } from 'react';
import type { ToolEvent } from '@/stores/chat-types';
import { useChatStore } from '@/stores/chatStore';

export interface RecallResultItem {
  title: string;
  confidence?: string;
  sourceType?: string;
  anchor?: string;
  snippet?: string;
}

export interface RecallEvent {
  id: string;
  query: string;
  mode?: string;
  scope?: string;
  timestamp: number;
  resultCount?: number;
  results?: RecallResultItem[];
}

/**
 * Pure: map an evidence anchor identifier to a navigable URL.
 * Thread anchors → /thread/{id}; everything else → evidence search.
 */
export function anchorToHref(anchor: string | undefined): string | null {
  if (!anchor) return null;
  if (anchor.startsWith('thread-')) {
    return `/thread/${anchor.slice('thread-'.length)}`;
  }
  return `/memory/search?q=${encodeURIComponent(anchor)}`;
}

const SEARCH_TOOL_NAMES = ['search_evidence', 'cat_cafe_search_evidence'];
const UNKNOWN_QUERY = '(unknown)';

/**
 * Check if a tool_use label refers to search_evidence.
 * Handles both raw names and "${catId} → toolName" production format.
 */
function isSearchEvidence(label: string): boolean {
  // Strip catId prefix: "opus → search_evidence" → "search_evidence"
  const toolName = label.includes(' → ') ? label.split(' → ').pop()! : label;
  return SEARCH_TOOL_NAMES.some((name) => toolName === name || toolName.endsWith(name));
}

function parseDetail(detail?: string): { query?: string; q?: string; mode?: string; scope?: string } {
  if (!detail) return {};
  try {
    return JSON.parse(detail) as { query?: string; q?: string; mode?: string; scope?: string };
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

function parseResultQueryFromText(text: string): ResultQueryMatch | undefined {
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

function isSearchEvidenceResultText(text: string): boolean {
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

function findPendingSearchIndex(pendingSearches: RecallEvent[], resultQuery: ResultQueryMatch | undefined): number {
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

function applyResultToRecall(recall: RecallEvent, text: string, resultQuery?: ResultQueryMatch): void {
  if (recall.query === UNKNOWN_QUERY && resultQuery?.kind === 'exact') {
    recall.query = resultQuery.query;
  }
  recall.resultCount = parseResultCountFromText(text) ?? 0;
  recall.results = parseTextResults(text);
}

/**
 * Pure: parse structured results from plain text output of evidence-tools.ts.
 * Format: "[confidence] title\n  anchor: ...\n  type: sourceType\n  > snippet"
 * Exported for testing.
 */
export function parseTextResults(text: string): RecallResultItem[] {
  if (!text) return [];
  const results: RecallResultItem[] = [];
  const lines = text.split('\n');

  // Status banners like [DEGRADED] use the same bracket format as results — skip them
  const STATUS_PREFIXES = new Set(['DEGRADED']);

  for (let i = 0; i < lines.length; i++) {
    // Match lines like "[high] F102 Memory Adapter"
    const match = lines[i].match(/^\[(\w+)\]\s+(.+)$/);
    if (!match) continue;
    if (STATUS_PREFIXES.has(match[1])) continue;

    const item: RecallResultItem = {
      confidence: match[1],
      title: match[2],
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

/**
 * Pure: filter ToolEvents to extract search_evidence calls with paired results.
 *
 * Pairing logic: search_evidence tool_result labels are generic
 * "${catId} ← result", not the tool name. Providers may also emit several
 * tool_use events before their results. New evidence output includes the query,
 * so prefer query matching; legacy untagged output falls back to FIFO.
 */
export function filterRecallEvents(events: ToolEvent[]): RecallEvent[] {
  const recalls: RecallEvent[] = [];
  const pendingSearches: RecallEvent[] = [];

  for (let i = 0; i < events.length; i++) {
    const evt = events[i];

    if (evt.type === 'tool_use' && isSearchEvidence(evt.label)) {
      const params = parseDetail(evt.detail);
      const recall: RecallEvent = {
        id: evt.id,
        query: params.query || params.q || UNKNOWN_QUERY,
        mode: params.mode,
        scope: params.scope,
        timestamp: evt.timestamp,
      };

      recalls.push(recall);
      pendingSearches.push(recall);
      continue;
    }

    if (evt.type === 'tool_result' && pendingSearches.length > 0) {
      const text = evt.detail ?? '';
      if (isSearchEvidenceResultText(text)) {
        const resultQuery = parseResultQueryFromText(text);
        const pendingIndex = findPendingSearchIndex(pendingSearches, resultQuery);
        if (pendingIndex >= 0) {
          const pending = pendingSearches[pendingIndex];
          if (!pending) continue;
          applyResultToRecall(pending, text, resultQuery);
          pendingSearches.splice(pendingIndex, 1);
        }
      }
    }
  }

  return recalls;
}

/**
 * React hook: returns RecallEvents from the current invocation's ToolEvents.
 */
export function useRecallEvents(): RecallEvent[] {
  const messages = useChatStore((s) => s.messages);

  return useMemo(() => {
    const allToolEvents: ToolEvent[] = [];
    for (const msg of messages) {
      if (msg.toolEvents) {
        allToolEvents.push(...msg.toolEvents);
      }
    }
    return filterRecallEvents(allToolEvents);
  }, [messages]);
}
