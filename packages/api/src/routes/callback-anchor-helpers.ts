/**
 * F236 Phase A — Anchor-first projection helpers for callback routes.
 *
 * These run at the INNERMOST callback-route projection layer (AC-A5), so HTTP /
 * agent-key / MCP callers all receive anchorized previews instead of full bodies.
 * MCP handlers stay pass-through (they forward route JSON verbatim).
 *
 * Honesty contract (变瞎子 gate / 信息完整性): every truncated field is
 * explicitly flagged (`truncated` / `requiresDrill` / `whyTruncated`) and carries
 * a low-cost, one-hop `drillDown` pointer back to the full content — a preview
 * must never pretend to be the whole thing.
 */

import type { TaskItem } from '@cat-cafe/shared';

/** Max chars kept in an anchor preview (~70 tokens). Single tunable source. */
export const PREVIEW_MAX_CHARS = 280;

export interface TruncateResult {
  preview: string;
  truncated: boolean;
}

/** Head-only truncation: keep the first `max` chars. Used for thread-context + task why. */
export function truncateHead(text: string, max: number = PREVIEW_MAX_CHARS): TruncateResult {
  if (text.length <= max) return { preview: text, truncated: false };
  return { preview: text.slice(0, max), truncated: true };
}

/**
 * Head+tail truncation: keep the first ~half and last ~half, with an honest
 * omission marker in the middle. Used for pending mentions where the actionable
 * handoff instruction (e.g. "@sonnet take over now") often sits at the END.
 */
export function truncateHeadTail(text: string, max: number = PREVIEW_MAX_CHARS): TruncateResult {
  if (text.length <= max) return { preview: text, truncated: false };
  const headLen = Math.ceil(max / 2);
  const tailLen = max - headLen;
  const omitted = text.length - headLen - tailLen;
  const head = text.slice(0, headLen);
  const tail = text.slice(text.length - tailLen);
  return { preview: `${head}…[+${omitted} chars]…${tail}`, truncated: true };
}

/**
 * Keyword-aware truncation (F236 R1 / 砚砚 P1 anti-变瞎子): when a result is
 * surfaced BECAUSE it matched a keyword, the preview must show WHY it matched.
 * Centers the preview window on the first keyword hit; honestly marks the omitted
 * head/tail char counts. Falls back to head-only when no term is found.
 */
export function truncateAroundMatch(
  text: string,
  keywordTerms: readonly string[],
  max: number = PREVIEW_MAX_CHARS,
): TruncateResult {
  if (text.length <= max) return { preview: text, truncated: false };
  const lower = text.toLowerCase();
  let hitIdx = -1;
  for (const term of keywordTerms) {
    if (!term) continue;
    const idx = lower.indexOf(term.toLowerCase());
    if (idx >= 0 && (hitIdx < 0 || idx < hitIdx)) hitIdx = idx;
  }
  if (hitIdx < 0) return truncateHead(text, max); // no hit → head-only fallback
  const half = Math.floor(max / 2);
  const start = Math.max(0, hitIdx - half);
  const end = Math.min(text.length, start + max);
  const head = start > 0 ? `…[+${start} chars]…` : '';
  const tail = end < text.length ? `…[+${text.length - end} chars]…` : '';
  return { preview: `${head}${text.slice(start, end)}${tail}`, truncated: true };
}

export interface MessageDrillDown {
  tool: 'cat_cafe_get_message';
  args: { messageId: string; mode: 'full'; agentKeyCatId?: string };
}

// F236 R1 / 云端 Codex P2: agent-key callers must carry agentKeyCatId on the drill call to
// resolve credentials. The server knows the caller principal, so it bakes the selector into
// the pointer → agent-key caller drills verbatim one-hop (invocation callers omit it).
function messageDrillDown(messageId: string, agentKeyCatId?: string): MessageDrillDown {
  return {
    tool: 'cat_cafe_get_message',
    args: { messageId, mode: 'full', ...(agentKeyCatId ? { agentKeyCatId } : {}) },
  };
}

/** Minimal message shape the anchor helpers read from. */
export interface AnchorableMessage {
  id: string;
  userId: string;
  catId: string | null;
  content: string;
  timestamp: number;
}

export interface AnchoredThreadMessage {
  id: string;
  threadId: string;
  timestamp: number;
  speaker: string;
  preview: string;
  contentLength: number;
  truncated: boolean;
  drillDown: MessageDrillDown;
  imagePaths?: string[];
  imageUrls?: string[];
}

/**
 * AC-A1/A2: project a thread-context message into a token-lean anchor.
 * - preview is keyword-aware when keywordTerms are supplied (F236 R1 / 砚砚 P1:
 *   a keyword-ranked result must show WHY it matched), else head-only
 * - injects effectiveThreadId at the item level (TD091 echo)
 * - speaker is supplied by the caller via the shared sender-display convention
 *   (getSenderName: human → co-creator, cat → displayName) — NEVER the raw internal
 *   userId (F236 R1 / 砚砚 P2: f148-navigation-context regression forbids leaking it)
 * - omits content/contentBlocks; keeps image hints as lightweight metadata
 */
export function anchorThreadMessage(
  item: AnchorableMessage,
  opts: {
    effectiveThreadId: string;
    speaker: string;
    keywordTerms?: readonly string[];
    agentKeyCatId?: string;
    imagePaths?: string[];
    imageUrls?: string[];
  },
): AnchoredThreadMessage {
  const { preview, truncated } =
    opts.keywordTerms && opts.keywordTerms.length > 0
      ? truncateAroundMatch(item.content, opts.keywordTerms)
      : truncateHead(item.content);
  return {
    id: item.id,
    threadId: opts.effectiveThreadId,
    timestamp: item.timestamp,
    speaker: opts.speaker,
    preview,
    contentLength: item.content.length,
    truncated,
    drillDown: messageDrillDown(item.id, opts.agentKeyCatId),
    ...(opts.imagePaths && opts.imagePaths.length > 0 ? { imagePaths: opts.imagePaths } : {}),
    ...(opts.imageUrls && opts.imageUrls.length > 0 ? { imageUrls: opts.imageUrls } : {}),
  };
}

export interface AnchoredPendingMention {
  id: string;
  from: string;
  message: string;
  timestamp: number;
  contentLength: number;
  requiresDrill: boolean;
  drillDown: MessageDrillDown;
  acked?: boolean;
}

/**
 * AC-A3: project a pending mention with a head+tail actionable excerpt.
 * Keeps the `from`/`message` field names for semantic continuity, but `message`
 * is now an excerpt; `requiresDrill` flags truncation honestly. `from` is supplied
 * by the caller via the shared sender-display convention (never raw userId, F236 R1).
 */
export function anchorPendingMention(
  item: AnchorableMessage,
  opts: { from: string; acked?: boolean },
): AnchoredPendingMention {
  const { preview, truncated } = truncateHeadTail(item.content);
  return {
    id: item.id,
    from: opts.from,
    message: preview,
    timestamp: item.timestamp,
    contentLength: item.content.length,
    requiresDrill: truncated,
    drillDown: messageDrillDown(item.id),
    ...(opts.acked !== undefined ? { acked: opts.acked } : {}),
  };
}

export interface TaskWhyDrillDown {
  tool: 'cat_cafe_list_tasks';
  args: { taskId: string };
}

export type AnchoredTask = TaskItem & {
  whyLength: number;
  whyTruncated: boolean;
  drillDown?: TaskWhyDrillDown;
};

/**
 * AC-A4: preview-ize the task `why` field ONLY (every other TaskItem field is
 * untouched — notably automationState, to avoid scope creep). When `full` is set
 * (drill via list_tasks?taskId=...), the complete why is returned verbatim.
 */
export function anchorTaskWhy(task: TaskItem, opts?: { full?: boolean }): AnchoredTask {
  const why = task.why ?? '';
  const { preview, truncated } = opts?.full ? { preview: why, truncated: false } : truncateHead(why);
  return {
    ...task,
    why: preview,
    whyLength: why.length,
    whyTruncated: truncated,
    ...(truncated ? { drillDown: { tool: 'cat_cafe_list_tasks', args: { taskId: task.id } } } : {}),
  };
}
