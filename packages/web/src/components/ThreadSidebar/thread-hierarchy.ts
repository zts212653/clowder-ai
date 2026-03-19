/**
 * Thread hierarchy utilities — parent/child grouping for orchestrated threads.
 *
 * Pure functions (no React). Follows the pattern of collapse-state.ts.
 */

import type { Thread } from '@/stores/chatStore';
import type { StorageLike } from './collapse-state';

export const HIERARCHY_STORAGE_KEY = 'cat-cafe:sidebar:hierarchy-expanded';

/** Check whether a child thread should nest under its parent or be promoted to root. */
function shouldNestUnderParent(t: Thread, parentIds: Set<string>): boolean {
  if (!t.parentThreadId) return false;
  // Parent not in current set (deleted/filtered/search miss) → promote to root
  if (!parentIds.has(t.parentThreadId)) return false;
  // Pinned or favorited children participate in groups independently
  if (t.pinned || t.favorited) return false;
  return true;
}

/**
 * Build a map from parent thread ID → sorted child threads.
 * Only nests children whose parent exists in the current set and
 * who don't have independent group semantics (pinned/favorited).
 */
export function buildChildMap(threads: readonly Thread[]): Map<string, Thread[]> {
  const ids = new Set(threads.map((t) => t.id));
  const map = new Map<string, Thread[]>();
  for (const t of threads) {
    if (!shouldNestUnderParent(t, ids)) continue;
    const existing = map.get(t.parentThreadId!);
    if (existing) {
      existing.push(t as Thread);
    } else {
      map.set(t.parentThreadId!, [t as Thread]);
    }
  }
  // Sort children by lastActiveAt descending within each parent
  for (const children of map.values()) {
    children.sort((a, b) => b.lastActiveAt - a.lastActiveAt);
  }
  return map;
}

/**
 * Return root threads — those that should participate in the grouping pipeline.
 * A thread is root if: no parentThreadId, parent missing from set, or pinned/favorited.
 */
export function getRootThreads(threads: readonly Thread[]): Thread[] {
  const ids = new Set(threads.map((t) => t.id));
  return threads.filter((t) => !shouldNestUnderParent(t, ids)) as Thread[];
}

/** Read persisted hierarchy-expanded thread IDs from storage. */
export function readHierarchyExpanded(storage: StorageLike): Set<string> {
  try {
    const raw = storage.getItem(HIERARCHY_STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed) && parsed.every((k) => typeof k === 'string')) {
        return new Set(parsed);
      }
    }
  } catch {
    // storage unavailable or corrupted
  }
  return new Set();
}

/** Persist hierarchy-expanded thread IDs to storage. */
export function writeHierarchyExpanded(expanded: Set<string>, storage: StorageLike): void {
  try {
    storage.setItem(HIERARCHY_STORAGE_KEY, JSON.stringify([...expanded]));
  } catch {
    // Best effort
  }
}
