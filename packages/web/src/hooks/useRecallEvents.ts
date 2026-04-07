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

/**
 * Parse result count from the "Found N result(s):" header line.
 */
function parseResultCountFromText(text: string): number | undefined {
  const match = text.match(/^Found (\d+) result\(s\):/m);
  return match ? Number.parseInt(match[1], 10) : undefined;
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
 * Pairing logic: after a search_evidence tool_use, the NEXT tool_result
 * (any label) is its result. Production tool_result labels are generic
 * "${catId} ← result", not the tool name.
 */
export function filterRecallEvents(events: ToolEvent[]): RecallEvent[] {
  const recalls: RecallEvent[] = [];

  for (let i = 0; i < events.length; i++) {
    const evt = events[i];
    if (evt.type !== 'tool_use' || !isSearchEvidence(evt.label)) continue;

    const params = parseDetail(evt.detail);
    const recall: RecallEvent = {
      id: evt.id,
      query: params.query || params.q || '(unknown)',
      mode: params.mode,
      scope: params.scope,
      timestamp: evt.timestamp,
    };

    // Pair with the next tool_result (by position, not label)
    for (let j = i + 1; j < events.length; j++) {
      const next = events[j];
      if (next.type === 'tool_result') {
        const text = next.detail ?? '';
        recall.resultCount = parseResultCountFromText(text) ?? 0;
        recall.results = parseTextResults(text);
        break;
      }
      // If we hit another tool_use before finding a result, stop looking
      if (next.type === 'tool_use') break;
    }

    recalls.push(recall);
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
