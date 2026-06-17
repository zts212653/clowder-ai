/**
 * ConciergeSearchContext (F229 KD-17)
 *
 * Pre-fetches search results in the routing pipeline (before model invocation),
 * numbers them R1-R{n}, writes to HandleMap, returns formatted prompt context.
 *
 * Called once per concierge thread message. The duty cat sees numbered results
 * and references them via [跳过去 R1] / [原地看 R1] markers in its reply.
 * The reply validator (concierge-reply-validator.ts) post-processes these markers
 * into CardBlock actions using the same HandleMap.
 *
 * Pattern: pre-fetch → inject → post-process (gemma clerk spike: 短 handle 9/9).
 */

import type { HandleAnchor, HandleEntry, IConciergeHandleMapStore } from './ConciergeHandleMapStore.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Minimal evidence store interface (subset of IEvidenceStore) */
export interface ConciergeEvidenceStore {
  search(
    query: string,
    options?: { limit?: number; scope?: string; mode?: string; depth?: string },
  ): Promise<ConciergeEvidenceItem[]>;
}

/** Minimal evidence item (subset of EvidenceItem from memory/interfaces) */
export interface ConciergeEvidenceItem {
  anchor: string;
  title: string;
  kind: string;
  summary?: string;
  /** drillDown.params has normalized threadId + messageId (from SqliteEvidenceStore) */
  drillDown?: {
    tool: string;
    params: Record<string, string>;
    hint: string;
  };
}

export interface BuildConciergeSearchContextOptions {
  userMessage: string;
  threadId: string;
  handleMapStore: IConciergeHandleMapStore;
  evidenceStore?: ConciergeEvidenceStore;
  maxResults?: number;
}

export interface ConciergeSearchContextResult {
  /** Formatted context string for prompt injection. Empty if no results. */
  contextString: string;
  /** Number of handles written to HandleMap */
  handleCount: number;
}

// ---------------------------------------------------------------------------
// Anchor parsing
// ---------------------------------------------------------------------------

/**
 * Parse evidence anchor + optional drillDown into HandleAnchor.
 *
 * Priority: drillDown.params (already normalized by SqliteEvidenceStore) > anchor parsing.
 *
 * Anchor formats (real memory index):
 * - "thread-thread_xyz" → threadId=thread_xyz, type=thread (IndexBuilder convention)
 * - "session-sess_123" → threadId=session-sess_123, type=session
 * - "feature:F229" → threadId=feature:F229, type=feature (best-effort)
 * - "docs/decisions/ADR-030.md" → threadId=docs/decisions/ADR-030.md, type=doc
 */
function parseAnchor(
  anchor: string,
  kind: string,
  title: string,
  drillDown?: ConciergeEvidenceItem['drillDown'],
): HandleAnchor {
  // Priority 1: drillDown.params has normalized IDs from SqliteEvidenceStore
  if (drillDown?.params?.threadId) {
    return {
      threadId: drillDown.params.threadId,
      ...(drillDown.params.messageId ? { messageId: drillDown.params.messageId } : {}),
      title,
      type: 'thread',
    };
  }

  // Priority 2: parse anchor string
  // Real memory index uses "thread-{threadId}" (with hyphen, not colon)
  if (anchor.startsWith('thread-')) {
    const threadId = anchor.slice('thread-'.length);
    return {
      threadId,
      title,
      type: 'thread',
    };
  }

  // Everything else: use the anchor as threadId, kind as type
  return {
    threadId: anchor,
    title,
    type: kind || 'doc',
  };
}

// ---------------------------------------------------------------------------
// Core
// ---------------------------------------------------------------------------

const DEFAULT_MAX_RESULTS = 10;

/**
 * Pre-fetch search results, number them, write to HandleMap, return prompt context.
 *
 * Fail-open: if evidenceStore is unavailable or search throws, returns empty context.
 */
export async function buildConciergeSearchContext(
  options: BuildConciergeSearchContextOptions,
): Promise<ConciergeSearchContextResult> {
  const { userMessage, threadId, handleMapStore, evidenceStore, maxResults = DEFAULT_MAX_RESULTS } = options;

  if (!evidenceStore) {
    return { contextString: '', handleCount: 0 };
  }

  let items: ConciergeEvidenceItem[];
  try {
    // P1-A + P1-C (KD-19, AC-A3 recall): pass thread-scoped + hybrid + passage-level.
    // scope='threads' recalls discussion threads (AC-A3 finds discussions, not conclusion docs → teleport works);
    // depth='raw' yields passage-level messageId (peek requires it, was always skipped without it).
    items = await evidenceStore.search(userMessage, {
      limit: maxResults,
      scope: 'threads',
      mode: 'hybrid',
      depth: 'raw',
    });
  } catch {
    // Fail-open: search failure → clear stale handles (P1-2 fix), no crash
    await handleMapStore.clearHandles(threadId).catch(() => {});
    return { contextString: '', handleCount: 0 };
  }

  if (items.length === 0) {
    // P1-2 fix: clear stale handles from previous turns
    await handleMapStore.clearHandles(threadId).catch(() => {});
    return { contextString: '', handleCount: 0 };
  }

  // Cap to maxResults
  const capped = items.slice(0, maxResults);

  // Build handle entries
  const handles: HandleEntry[] = capped.map((item, i) => ({
    label: `R${i + 1}`,
    anchor: parseAnchor(item.anchor, item.kind, item.title, item.drillDown),
  }));

  // Write to HandleMap (replaces any existing handles for this thread)
  await handleMapStore.setHandles(threadId, handles);

  // Build formatted context string for prompt injection
  const lines: string[] = ['', '**搜索结果（用标记引用，如 [跳过去 R1] 或 [原地看 R1]）：**'];
  for (const h of handles) {
    const snippet = capped[parseInt(h.label.slice(1)) - 1]?.summary ?? '';
    const snippetPart = snippet ? ` — ${snippet.slice(0, 80)}` : '';
    lines.push(`- ${h.label}: 《${h.anchor.title}》(${h.anchor.type})${snippetPart}`);
  }
  lines.push('');

  return {
    contextString: lines.join('\n'),
    handleCount: handles.length,
  };
}
