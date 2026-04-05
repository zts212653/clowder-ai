/**
 * Redis key patterns for tool usage counters — F150 (#339).
 * Key: tool-stats:{YYYY-MM-DD}:{catId}:{category}:{toolName}
 * TTL: 90 days.
 */

export const TOOL_USAGE_TTL_SECONDS = 90 * 24 * 60 * 60; // 90 days

/** Counter key for a single tool on a given day. */
export function toolUsageKey(date: string, catId: string, category: string, toolName: string): string {
  return `tool-stats:${date}:${catId}:${category}:${toolName}`;
}

/** SCAN pattern to match all tool-stats keys (single scan, client-side date filter). */
export const TOOL_USAGE_SCAN_ALL = 'tool-stats:*';
