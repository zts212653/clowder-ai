/**
 * Thread hierarchy utilities — parent/child grouping for orchestrated threads.
 *
 * Pure functions (no React). Follows the pattern of collapse-state.ts.
 */

import type { Thread } from '@/stores/chatStore';
import type { StorageLike } from './collapse-state';

export const HIERARCHY_STORAGE_KEY = 'cat-cafe:sidebar:hierarchy-expanded';

/**
 * Build a map from parent thread ID → sorted child threads.
 * Returns empty map when no threads have parentThreadId.
 */
export function buildChildMap(threads: readonly Thread[]): Map<string, Thread[]> {
  const map = new Map<string, Thread[]>();
  for (const t of threads) {
    if (!t.parentThreadId) continue;
    const existing = map.get(t.parentThreadId);
    if (existing) {
      existing.push(t as Thread);
    } else {
      map.set(t.parentThreadId, [t as Thread]);
    }
  }
  // Sort children by lastActiveAt descending within each parent
  for (const children of map.values()) {
    children.sort((a, b) => b.lastActiveAt - a.lastActiveAt);
  }
  return map;
}

/**
 * Return only root threads (those without a parentThreadId).
 * These are passed into the existing grouping pipeline.
 */
export function getRootThreads(threads: readonly Thread[]): Thread[] {
  return threads.filter((t) => !t.parentThreadId) as Thread[];
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
