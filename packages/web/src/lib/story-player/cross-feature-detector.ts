/**
 * F252 AC-E6 — Cross-Feature Event Detection
 *
 * Pure function that identifies cross-feature interactions in replay events.
 * A cross-feature event is a cross_post_message tool call where the target
 * threadId is NOT in the current feature's thread set.
 *
 * Design:
 * - Feature replay already knows which threads belong to the feature (from lanes)
 * - cross_post_message toolInput contains { threadId, content, ... }
 * - If target threadId ∉ featureThreadIds → cross-feature interaction
 */

import type { ReplayEvent } from './types';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface CrossFeatureInfo {
  /** Index of the triggering event in the replay sequence */
  eventIndex: number;
  /** Target thread ID (outside current feature) */
  targetThreadId: string;
  /** Truncated content preview (max 100 chars) */
  contentSnippet: string;
  /** Cat that initiated the cross-feature interaction */
  catId: string | undefined;
}

// ---------------------------------------------------------------------------
// Tool name normalization (shared pattern with adaptive-pacing.ts)
// ---------------------------------------------------------------------------

/**
 * Match any normalized variant of cross_post_message:
 * - "cat_cafe_cross_post_message" (bare canonical)
 * - "cross_post_message" (short alias from mcp:cat-cafe/cross_post_message)
 *
 * Uses endsWith to match both — same pattern as API routing
 * (route-serial.ts:267-268). Cloud R4 P2 fix.
 */
const CROSS_POST_SUFFIX = 'cross_post_message';
const MAX_SNIPPET_LENGTH = 100;

/**
 * Normalize MCP-prefixed tool names to bare form.
 * - Codex: "mcp:server/tool_name" → "tool_name"
 * - Claude Code: "mcp__server__tool_name" → "tool_name"
 */
function normalizeTool(raw: string): string {
  if (raw.includes('/')) return raw.split('/').pop() ?? raw;
  if (raw.includes('__')) return raw.split('__').pop() ?? raw;
  return raw;
}

// ---------------------------------------------------------------------------
// Detection
// ---------------------------------------------------------------------------

/**
 * Detect if a replay event is a cross-feature interaction.
 *
 * @param event - The replay event to check
 * @param featureThreadIds - Set of thread IDs belonging to the current feature
 * @returns CrossFeatureInfo if cross-feature, null otherwise
 */
export function detectCrossFeatureEvent(
  event: ReplayEvent,
  featureThreadIds: ReadonlySet<string>,
): CrossFeatureInfo | null {
  // Only tool_call events can be cross-feature
  if (event.type !== 'tool_call') return null;

  // Must be a cross_post_message tool call
  const toolName = normalizeTool(event.toolName ?? '');
  if (!toolName.endsWith(CROSS_POST_SUFFIX)) return null;

  // Parse toolInput for target threadId
  if (!event.toolInput) return null;

  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(event.toolInput) as Record<string, unknown>;
  } catch {
    return null;
  }

  const targetThreadId = parsed.threadId;
  if (typeof targetThreadId !== 'string') return null;

  // If target thread is in the current feature → not cross-feature
  if (featureThreadIds.has(targetThreadId)) return null;

  // Extract content snippet
  const rawContent = typeof parsed.content === 'string' ? parsed.content : '';
  const contentSnippet =
    rawContent.length > MAX_SNIPPET_LENGTH ? `${rawContent.slice(0, MAX_SNIPPET_LENGTH)}...` : rawContent;

  return {
    eventIndex: event.index,
    targetThreadId,
    contentSnippet,
    catId: event.catId,
  };
}
