/**
 * WorklistRegistry — live per-invocation A2A guard state.
 *
 * A2A execution itself is owned by the durable message_wake Queue path. This
 * registry only lets callbacks in the currently running invocation share the
 * depth/ping-pong projection rebuilt from persisted causal history.
 *
 * Registry key is `parentInvocationId` (unique per invocation) when provided,
 * with `threadId` as the direct-callback coordinate. A reverse index lets a
 * fresh user input reset all live streak projections for its thread.
 *
 * It does not own or extend an execution worklist.
 */

import type { CatId } from '@cat-cafe/shared';

export interface WorklistEntry {
  /** A2A depth reconstructed from durable response ancestry. */
  a2aCount: number;
  /** Max allowed A2A depth */
  maxDepth: number;
  /**
   * F167 L1: ping-pong streak tracking — records the last same-pair (A↔B) push run.
   * Incremented on every admitted 1-target A2A wake where {caller, target} matches this pair
   * (order-insensitive). Reset to {new pair, count=1} when the pair changes, or
   * cleared by `resetStreak()` (called on user messages). See `streakPair.count`
   * thresholds: >=2 warn, >=4 block.
   */
  streakPair?: { from: CatId; to: CatId; count: number };
}

/** F167 L1: streak thresholds. Hardcoded per KD (YAGNI — no config). */
const PINGPONG_WARN_THRESHOLD = 2;
const PINGPONG_BLOCK_THRESHOLD = 4;

/**
 * F167 Phase D (KD-18): tools that are routing/holding themselves, not work evidence.
 * These MUST NOT count as "substantive work" — otherwise MCP routing paths would
 * always bypass the ping-pong breaker (breaker 被打穿).
 *
 * Match via substring so provider-prefixed names like
 * `mcp__cat-cafe__cat_cafe_post_message` also match.
 */
const NON_SUBSTANTIVE_TOOL_PATTERNS: readonly string[] = [
  'cat_cafe_post_message',
  'cat_cafe_multi_mention',
  'cat_cafe_hold_ball',
] as const;

/**
 * F167 Phase D: returns true iff the given tool name represents substantive work
 * (anything except pure routing / holding). Empty string → false (defensive).
 */
export function isSubstantiveTool(toolName: string): boolean {
  if (!toolName) return false;
  return !NON_SUBSTANTIVE_TOOL_PATTERNS.some((p) => toolName.includes(p));
}

/** F167 L1: two cat pairs are the same if they share the same unordered set of cats. */
function samePair(a: { from: CatId; to: CatId }, bFrom: CatId, bTo: CatId): boolean {
  return (a.from === bFrom && a.to === bTo) || (a.from === bTo && a.to === bFrom);
}

/** Shared streak verdict used by callback admission and completed-response admission. */
export interface StreakResult {
  warnPingPong: boolean;
  blockPingPong: boolean;
  count: number;
}

/**
 * F167 Phase D: upstream caller's activity signature, used to decide whether
 * a same-pair push is "work" (exempt from streak) or "language inertia" (streak++).
 */
export interface CallerActivity {
  /** True iff any tool_use in this turn passed `isSubstantiveTool()` (non-routing). */
  hadSubstantiveToolCall: boolean;
  /** Length of the stored output text in characters. */
  outputLength: number;
}

/** F167 Phase D: output length threshold above which text is considered real discussion. */
const OUTPUT_LEN_T = 200;

/**
 * F167 Phase D: a same-pair push is exempt from streak accumulation iff the
 * caller was doing real work (substantive tool call) OR producing long content
 * (architecture discussion). Both-false (short text + only routing tools) is
 * the "pure language inertia" signature that deserves to be counted.
 */
function isSubstantiveActivity(activity?: CallerActivity): boolean {
  if (!activity) return false;
  return activity.hadSubstantiveToolCall || activity.outputLength > OUTPUT_LEN_T;
}

/** F167 L1: pure verdict from a (possibly predicted) post-push streak count. */
function streakVerdict(count: number): StreakResult {
  return {
    warnPingPong: count >= PINGPONG_WARN_THRESHOLD && count < PINGPONG_BLOCK_THRESHOLD,
    blockPingPong: count >= PINGPONG_BLOCK_THRESHOLD,
    count,
  };
}

/**
 * F167 Phase D rule, factored out as a PURE prediction (no mutation):
 * same-pair inertia (short text + no substantive tool) → count+1;
 * same-pair substantive work / long discussion → RESET to 1 (a real-work round breaks inertia,
 * otherwise `3 short + 1 substantive + 1 short` would still block on round 5 — gpt52 P1-1);
 * different/new pair → 1.
 */
function predictStreakCount(
  entry: Pick<WorklistEntry, 'streakPair'>,
  callerCatId: CatId,
  target: CatId,
  activity?: CallerActivity,
): number {
  if (entry.streakPair && samePair(entry.streakPair, callerCatId, target)) {
    return isSubstantiveActivity(activity) ? 1 : entry.streakPair.count + 1;
  }
  return 1;
}

/**
 * Read-only streak prediction. Durable admission must decide before it mutates
 * either the live guard state or Queue custody.
 * `wouldBlock` mirrors StreakResult.blockPingPong (parity test guards this).
 */
export function peekStreakOnPush(
  entry: Pick<WorklistEntry, 'streakPair'>,
  callerCatId: CatId,
  target: CatId,
  activity?: CallerActivity,
): { wouldBlock: boolean; wouldWarn: boolean; count: number } {
  const count = predictStreakCount(entry, callerCatId, target, activity);
  const v = streakVerdict(count);
  return { wouldBlock: v.blockPingPong, wouldWarn: v.warnPingPong, count };
}

/** F167 L1: ping-pong streak record — see WorklistEntry.streakPair. Mutates entry.streakPair. */
export function updateStreakOnPush(
  entry: Pick<WorklistEntry, 'streakPair'>,
  callerCatId: CatId,
  target: CatId,
  activity?: CallerActivity,
): StreakResult {
  // Shared rule with peekStreakOnPush (parity): compute predicted count, then write it.
  const count = predictStreakCount(entry, callerCatId, target, activity);
  if (entry.streakPair && samePair(entry.streakPair, callerCatId, target)) {
    entry.streakPair.count = count;
    entry.streakPair.from = callerCatId;
    entry.streakPair.to = target;
  } else {
    entry.streakPair = { from: callerCatId, to: target, count };
  }
  return streakVerdict(count);
}

/** Primary registry: registryKey → WorklistEntry */
const registry = new Map<string, WorklistEntry>();

/** F108: Reverse index: threadId → Set<registryKey> (for thread-level hasWorklist) */
const threadIndex = new Map<string, Set<string>>();

/** Compute registry key: parentInvocationId when provided, threadId as fallback */
function registryKey(threadId: string, parentInvocationId?: string): string {
  return parentInvocationId ?? threadId;
}

/**
 * Register a worklist for an invocation. Called by routeSerial at start.
 * Returns the entry for routeSerial to read a2aCount updates.
 *
 * @param parentInvocationId - unique invocation ID for concurrent isolation.
 *   When omitted, the direct callback is coordinated by thread ID.
 */
export function registerWorklist(
  threadId: string,
  _worklist: readonly CatId[],
  maxDepth: number,
  parentInvocationId?: string,
  initialLineage?: Pick<WorklistEntry, 'a2aCount' | 'streakPair'>,
): WorklistEntry {
  const key = registryKey(threadId, parentInvocationId);
  const entry: WorklistEntry = {
    a2aCount: initialLineage?.a2aCount ?? 0,
    maxDepth,
    ...(initialLineage?.streakPair ? { streakPair: { ...initialLineage.streakPair } } : {}),
  };
  registry.set(key, entry);

  // Maintain reverse index
  let keys = threadIndex.get(threadId);
  if (!keys) {
    keys = new Set();
    threadIndex.set(threadId, keys);
  }
  keys.add(key);

  return entry;
}

/**
 * Unregister worklist for an invocation. Called by routeSerial on exit.
 * Owner check: only removes if the stored entry matches the caller's entry.
 * This prevents a preempting new invocation's worklist from being deleted
 * by the old invocation's finally block. (缅因猫 R1 P1-1)
 */
export function unregisterWorklist(threadId: string, owner?: WorklistEntry, parentInvocationId?: string): void {
  const key = registryKey(threadId, parentInvocationId);
  if (owner) {
    const current = registry.get(key);
    if (current !== owner) return; // Stale caller — new invocation owns the slot
  }
  registry.delete(key);

  // Maintain reverse index
  const keys = threadIndex.get(threadId);
  if (keys) {
    keys.delete(key);
    if (keys.size === 0) threadIndex.delete(threadId);
  }
}

/**
 * F167 L1: Reset streak for a thread's active worklist (user-message hook).
 * Called when a user message arrives — fresh turn, streak shouldn't carry over.
 *
 * When `parentInvocationId` is omitted, clears streak on ALL worklists for the
 * thread via the reverse index. This matches the user-POST caller (messages.ts)
 * which has no parentInvocationId — route-serial registers entries keyed by
 * parentInvocationId (F108), so a single-key lookup would miss them.
 */
export function resetStreak(threadId: string, parentInvocationId?: string): void {
  if (parentInvocationId !== undefined) {
    const key = registryKey(threadId, parentInvocationId);
    const entry = registry.get(key);
    if (entry) entry.streakPair = undefined;
    return;
  }
  const keys = threadIndex.get(threadId);
  if (!keys) return;
  for (const key of keys) {
    const entry = registry.get(key);
    if (entry) entry.streakPair = undefined;
  }
}

/**
 * Get the worklist entry for a specific invocation or thread.
 * @param parentInvocationId - get a specific invocation's live guard state.
 *   When omitted, uses the direct callback's thread coordinate.
 */
export function getWorklist(threadId: string, parentInvocationId?: string): WorklistEntry | undefined {
  const key = registryKey(threadId, parentInvocationId);
  return registry.get(key);
}
