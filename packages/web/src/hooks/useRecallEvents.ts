/**
 * F102 Phase J: Hook + pure helpers for extracting search_evidence ToolEvents
 * from the current invocation's event stream.
 *
 * Production data shapes:
 * - tool_use.label = "${catId} → ${toolName}" (e.g. "opus → search_evidence")
 * - tool_result.label = "${catId} ← result" (generic, no tool name)
 * - tool_result.detail = complete visible text from evidence-tools.ts, with recall metadata separated
 */

import {
  parseRecallMetaFromText,
  type RecallMatchRank,
  type RecallMatchType,
  type RecallPreviewItem,
  type RecallResultStatus,
} from '@cat-cafe/shared';
import { useEffect, useMemo, useState } from 'react';
import type { ToolEvent } from '@/stores/chat-types';
import { useChatStore } from '@/stores/chatStore';
import { apiFetch } from '@/utils/api-client';

export interface RecallResultItem {
  title: string;
  matchRank?: RecallMatchRank;
  matchType?: RecallMatchType;
  authority?: string;
  updatedAt?: string;
  sourceType?: string;
  anchor?: string;
  snippet?: string;
  /** F263 B.5: whether this specific candidate was consumed (used) by the cat */
  consumed?: boolean;
}

export interface RecallEvent {
  id: string;
  toolName?: string;
  query: string;
  mode?: string;
  scope?: string;
  timestamp: number;
  resultCount?: number;
  resultStatus?: RecallResultStatus;
  results?: RecallResultItem[];
  /** F263 B.5: 'push' (system-injected) or 'pull' (cat-initiated search) */
  source?: 'push' | 'pull';
  /** F263 B.5: for push events, which pipeline (e.g. 'session_bootstrap', 'cold_context') */
  pushSurface?: string;
  /** F263 B.5: whether the cat inspected the results */
  inspected?: boolean;
  /** F263 B.5: 'used' or 'ignored' */
  outcome?: 'used' | 'ignored';
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

function scopeSuffix(scope: string | undefined): string {
  return scope ? ` · ${scope}` : '';
}

export function recallEventDisplayTitle(event: RecallEvent): string {
  const query = event.query.trim();
  if (query) return query;

  switch (event.toolName) {
    case 'list_recent':
      return `最近记忆${scopeSuffix(event.scope)}`;
    case 'graph_resolve':
      return `关系图${scopeSuffix(event.scope)}`;
    case 'search_evidence':
    case 'cat_cafe_search_evidence':
      return '未知查询';
    default:
      return event.toolName ? `${event.toolName}${scopeSuffix(event.scope)}` : '未知查询';
  }
}

export function recallEventResultLabel(event: RecallEvent): string | undefined {
  if (event.resultCount != null) return `${event.resultCount} 条命中`;
  switch (event.resultStatus) {
    case 'overflow':
      return '结果已存档';
    case 'parser_miss':
    case 'result_unmerged':
      return '统计待解析';
    case 'legacy_unknown':
      return '历史统计缺失';
    case 'error':
      return '召回失败';
    case 'no_results':
      return '0 条命中';
  }
  return event.results != null ? '统计待解析' : undefined;
}

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

function isUnknownCountEvidenceFailure(text: string): boolean {
  return /result exceeds maximum allowed tokens|maximum allowed tokens|Full result saved to|saved to .*\.txt/i.test(
    text,
  );
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
  } else if (!hasStructuredMeta && recall.resultCount == null && !isUnknownCountEvidenceFailure(text)) {
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
        toolName: 'search_evidence',
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
      const resultText = evt.resultMeta ? `${text}\n${evt.resultMeta}` : text;
      if (isSearchEvidenceResultText(resultText)) {
        const resultQuery = parseResultQueryFromText(resultText);
        const pendingIndex = findPendingSearchIndex(pendingSearches, resultQuery);
        if (pendingIndex >= 0) {
          const pending = pendingSearches[pendingIndex];
          if (!pending) continue;
          applyResultToRecall(pending, resultText, resultQuery);
          pendingSearches.splice(pendingIndex, 1);
        }
      }
    }
  }

  return recalls;
}

/**
 * Deduplicate recall events: live toolEvents take precedence (richer detail)
 * over API history events. When a live event matches a history event,
 * merge consumption metadata (consumed, source, outcome) from history
 * into the live event — live events don't have consumed_json from the
 * correlation pipeline. Dedup key = timestamp + toolName + query.
 */
export function deduplicateRecallEvents(live: RecallEvent[], history: RecallEvent[]): RecallEvent[] {
  const eventKey = (e: RecallEvent) => `${e.timestamp}:${e.toolName ?? ''}:${e.query}`;
  const historyByKey = new Map(history.map((e) => [eventKey(e), e]));

  const merged = live.map((liveEvt) => {
    const histEvt = historyByKey.get(eventKey(liveEvt));
    if (!histEvt) return liveEvt;
    // Merge consumption metadata from history into live event
    const mergedResults = liveEvt.results?.map((r) => {
      if (r.consumed != null) return r; // already has consumed info
      const histResult = histEvt.results?.find((hr) => hr.anchor === r.anchor);
      return histResult?.consumed != null ? { ...r, consumed: histResult.consumed } : r;
    });
    return {
      ...liveEvt,
      source: liveEvt.source ?? histEvt.source,
      pushSurface: liveEvt.pushSurface ?? histEvt.pushSurface,
      inspected: liveEvt.inspected ?? histEvt.inspected,
      outcome: liveEvt.outcome ?? histEvt.outcome,
      ...(mergedResults ? { results: mergedResults } : {}),
    };
  });

  const liveKeys = new Set(live.map(eventKey));
  const unique = history.filter((e) => !liveKeys.has(eventKey(e)));
  return [...merged, ...unique].sort((a, b) => a.timestamp - b.timestamp);
}

/**
 * React hook: returns RecallEvents from both live ToolEvents (current session)
 * and persistent recall_events table (survives page refresh / thread switch).
 *
 * F102 bugfix: previously, RecallFeed only read from in-memory chat messages
 * (limited to HISTORY_PAGE_SIZE=50 per API fetch). Old recall events disappeared
 * after page refresh. Now queries the persistent recall_events table via API.
 */
export function useRecallEvents(): RecallEvent[] {
  const messages = useChatStore((s) => s.messages);
  const threadId = useChatStore((s) => s.currentThreadId);
  const [historyEvents, setHistoryEvents] = useState<RecallEvent[]>([]);

  // Fetch historical recall events from SQLite via API
  useEffect(() => {
    // Clear stale history immediately on thread switch / missing threadId
    setHistoryEvents([]);
    if (!threadId) return;
    let cancelled = false;
    apiFetch(`/api/recall/events?threadId=${encodeURIComponent(threadId)}&limit=100`)
      .then((res) => {
        if (!res.ok || cancelled) return;
        return res.json();
      })
      .then((data: { events?: RecallEvent[] } | undefined) => {
        if (cancelled || !data?.events) return;
        setHistoryEvents(data.events);
      })
      .catch(() => {
        // Silently degrade — live toolEvents still work
      });
    return () => {
      cancelled = true;
    };
  }, [threadId]);

  // Extract live recall events from in-memory chat messages
  const liveEvents = useMemo(() => {
    const allToolEvents: ToolEvent[] = [];
    for (const msg of messages) {
      if (msg.toolEvents) {
        allToolEvents.push(...msg.toolEvents);
      }
    }
    return filterRecallEvents(allToolEvents);
  }, [messages]);

  // Merge: live events (richer detail) + history (persistence), deduplicated
  return useMemo(() => deduplicateRecallEvents(liveEvents, historyEvents), [liveEvents, historyEvents]);
}
