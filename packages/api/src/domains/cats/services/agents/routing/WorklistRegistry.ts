/**
 * WorklistRegistry — per-invocation worklist for A2A unification (F27 + F108)
 *
 * When routeSerial is running, it registers its worklist here.
 * Callback A2A triggers (MCP post_message with @mention) push
 * targets into the worklist instead of spawning independent invocations.
 *
 * F108: Registry key is `parentInvocationId` (unique per invocation) when
 * provided, falling back to `threadId` for backward compatibility.
 * A reverse index (threadId → Set<registryKey>) enables thread-level
 * lookups (`hasWorklist(threadId)`) for routing decisions.
 *
 * All A2A chains share the parent's AbortController, isFinal semantics,
 * and MAX_A2A_DEPTH limit.
 */

import type { CatId } from '@cat-cafe/shared';

/** F122: Structured result from pushToWorklist — reason explains empty adds */
export type PushReason = 'not_found' | 'depth_limit' | 'caller_mismatch' | 'all_duplicate';
export interface PushResult {
  added: CatId[];
  reason?: PushReason;
}

export interface WorklistEntry {
  /** The mutable worklist array — push to extend */
  list: CatId[];
  /** Number of original user-selected targets at registration time */
  originalCount: number;
  /** A2A depth counter — incremented on each push */
  a2aCount: number;
  /** Max allowed A2A depth */
  maxDepth: number;
  /** Index of the cat currently being executed (updated by routeSerial).
   *  Used for dedup: cats already executed can be re-enqueued. */
  executedIndex: number;
  /**
   * A2A sender mapping — for each enqueued target, record who @mentioned it.
   * Used to inject "Direct message from ...; reply to ..." into the target's prompt.
   */
  a2aFrom: Map<CatId, CatId>;
  /**
   * A2A trigger message mapping — for each enqueued target, record which message triggered it.
   * Used by auto-replyTo to thread replies back to the triggering @mention message.
   */
  a2aTriggerMessageId: Map<CatId, string>;
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
 * @param parentInvocationId - F108: unique invocation ID for concurrent isolation.
 *   When omitted, threadId is used as the key (backward compat).
 */
export function registerWorklist(
  threadId: string,
  worklist: CatId[],
  maxDepth: number,
  parentInvocationId?: string,
): WorklistEntry {
  const key = registryKey(threadId, parentInvocationId);
  const entry: WorklistEntry = {
    list: worklist,
    originalCount: worklist.length,
    a2aCount: 0,
    maxDepth,
    executedIndex: 0,
    a2aFrom: new Map(),
    a2aTriggerMessageId: new Map(),
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
 * Push cats to an invocation's worklist (callback A2A path).
 * Dedup only against pending (not-yet-executed) portion — cats that already
 * ran can be re-enqueued for another round (e.g. A→B→A review ping-pong).
 *
 * Caller guard (cloud Codex P1): if `callerCatId` is provided, only the cat
 * currently being executed by routeSerial may push to the worklist. This
 * prevents stale callbacks from a preempted invocation from injecting targets
 * into a newer invocation's worklist.
 *
 * @param parentInvocationId - F108: target specific invocation's worklist.
 *   When omitted, uses threadId as key (backward compat).
 *
 * F122: Returns structured PushResult with reason explaining empty adds.
 */
export function pushToWorklist(
  threadId: string,
  cats: CatId[],
  callerCatId?: CatId,
  parentInvocationId?: string,
  triggerMessageId?: string,
): PushResult {
  const key = registryKey(threadId, parentInvocationId);
  const entry = registry.get(key);
  if (!entry) return { added: [], reason: 'not_found' };

  // Caller authorization: only the currently-executing cat may push
  if (callerCatId !== undefined) {
    const currentCat = entry.list[entry.executedIndex];
    if (currentCat !== callerCatId) return { added: [], reason: 'caller_mismatch' };
  }

  // Only dedup against pending tail (from executedIndex onward)
  const pending = entry.list.slice(entry.executedIndex);

  const added: CatId[] = [];
  let hitDepthLimit = false;
  for (const cat of cats) {
    if (entry.a2aCount >= entry.maxDepth) {
      hitDepthLimit = true;
      break;
    }
    if (!pending.includes(cat)) {
      entry.list.push(cat);
      entry.a2aCount++;
      added.push(cat);
      pending.push(cat); // Keep local dedup view in sync
      if (callerCatId !== undefined) {
        entry.a2aFrom.set(cat, callerCatId);
      }
      if (triggerMessageId !== undefined) {
        entry.a2aTriggerMessageId.set(cat, triggerMessageId);
      }
    } else if (callerCatId !== undefined) {
      // Target already pending:
      // - original targets must keep replying to user (no A2A sender override)
      // - A2A-enqueued targets may update to latest sender before execution
      const existingIndex = entry.list.findIndex((id, idx) => idx >= entry.executedIndex && id === cat);
      const isOriginalPendingTarget = existingIndex !== -1 && existingIndex < entry.originalCount;
      if (!isOriginalPendingTarget) {
        entry.a2aFrom.set(cat, callerCatId);
        // F121: Keep triggerMessageId in sync with a2aFrom (same "latest sender" semantics)
        if (triggerMessageId !== undefined) {
          entry.a2aTriggerMessageId.set(cat, triggerMessageId);
        }
      }
    }
  }
  if (added.length === 0) {
    return { added: [], reason: hitDepthLimit ? 'depth_limit' : 'all_duplicate' };
  }
  return { added };
}

/** Check if a thread has any active worklist (any invocation running). */
export function hasWorklist(threadId: string): boolean {
  const keys = threadIndex.get(threadId);
  return keys !== undefined && keys.size > 0;
}

/**
 * Get the worklist entry for a specific invocation or thread.
 * @param parentInvocationId - F108: get specific invocation's worklist.
 *   When omitted, uses threadId as key (backward compat / legacy single-invocation).
 */
export function getWorklist(threadId: string, parentInvocationId?: string): WorklistEntry | undefined {
  const key = registryKey(threadId, parentInvocationId);
  return registry.get(key);
}
