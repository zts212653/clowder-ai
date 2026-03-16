/**
 * F095 Phase A: Collapse state persistence logic (pure functions, no React).
 */

export const STORAGE_KEY = 'cat-cafe:sidebar:collapsed-groups';

export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

/** Read persisted collapsed groups from storage. Returns null if nothing stored/invalid. */
export function readCollapsedGroups(storage: StorageLike): string[] | null {
  try {
    const raw = storage.getItem(STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed) && parsed.every((k) => typeof k === 'string')) {
        return parsed;
      }
    }
  } catch {
    // storage unavailable or corrupted
  }
  return null;
}

/** Persist collapsed groups to storage. */
export function writeCollapsedGroups(groupKeys: string[], storage: StorageLike): void {
  try {
    storage.setItem(STORAGE_KEY, JSON.stringify(groupKeys));
  } catch {
    // Best effort
  }
}

/** Compute initial collapsed set: restore from storage, or default to all collapsed. */
export function initCollapsedSet(allGroupKeys: string[], storage: StorageLike): Set<string> {
  const stored = readCollapsedGroups(storage);
  if (stored !== null) return new Set(stored);
  return new Set(allGroupKeys);
}

/** Determine if a group should render as collapsed. */
export function shouldCollapse(groupKey: string, collapsedSet: Set<string>, searchQuery: string): boolean {
  if (searchQuery.length > 0) return false;
  return collapsedSet.has(groupKey);
}

/** Before storage is read, default to collapsed (prevents first-render flicker). */
// eslint-disable-next-line @typescript-eslint/no-unused-vars
export function shouldCollapseBeforeInit(_groupKey: string): boolean {
  return true;
}

/**
 * Resolve collapse state for a group, handling pre-init + search priority.
 * This is the pure-function equivalent of the hook's isCollapsed callback.
 */
export function resolveCollapse(
  groupKey: string,
  collapsedSet: Set<string>,
  searchQuery: string,
  isInitialized: boolean,
): boolean {
  if (searchQuery.length > 0) return false;
  if (!isInitialized) return shouldCollapseBeforeInit(groupKey);
  return shouldCollapse(groupKey, collapsedSet, searchQuery);
}

/** Return empty set (all expanded). */
export function expandAllGroups(): Set<string> {
  return new Set();
}

/** Return set containing all provided keys (all collapsed). */
export function collapseAllGroups(allKnownKeys: string[]): Set<string> {
  return new Set(allKnownKeys);
}

/**
 * Find the group key that contains a given thread ID.
 * When a thread appears in multiple groups (e.g. both 'recent' and a project group),
 * prefer project/pinned groups over 'recent' to avoid sidebar jumping. (clowder-ai#89)
 */
export function findGroupKeyForThread(
  threadId: string,
  groups: { groupKey: string; threadIds: string[]; type?: string }[],
): string | undefined {
  let recentFallback: string | undefined;
  for (const g of groups) {
    if (g.threadIds.includes(threadId)) {
      if (g.type === 'recent') {
        if (!recentFallback) recentFallback = g.groupKey;
      } else {
        return g.groupKey;
      }
    }
  }
  return recentFallback;
}
