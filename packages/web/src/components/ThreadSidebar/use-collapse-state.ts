'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import {
  collapseAllGroups,
  expandAllGroups,
  findGroupKeyForThread,
  initCollapsedSet,
  resolveCollapse,
  type StorageLike,
  writeCollapsedGroups,
} from './collapse-state';
import type { ThreadGroup } from './thread-utils';

/** Group key extraction — matches ThreadSidebar's groupKey logic */
function getGroupKey(group: ThreadGroup): string {
  return group.projectPath ?? group.type;
}

function getGroupKeys(group: ThreadGroup): string[] {
  const keys = [getGroupKey(group)];
  const archivedGroups = group.archivedGroups;
  if (!archivedGroups) return keys;
  for (const archivedGroup of archivedGroups) {
    keys.push(...getGroupKeys(archivedGroup));
  }
  return keys;
}

function getAllGroupKeys(groups: ThreadGroup[]): string[] {
  return groups.flatMap(getGroupKeys);
}

function findArchivedSubgroupKeyForThread(threadId: string, groups: ThreadGroup[]): string | undefined {
  for (const group of groups) {
    const archivedGroups = group.archivedGroups;
    if (!archivedGroups) continue;
    for (const archivedGroup of archivedGroups) {
      if (archivedGroup.threads.some((thread) => thread.id === threadId)) {
        return getGroupKey(archivedGroup);
      }
    }
  }
  return undefined;
}

function getStorage(): StorageLike {
  return typeof window !== 'undefined' ? window.localStorage : { getItem: () => null, setItem: () => {} };
}

export interface UseCollapseStateOptions {
  threadGroups: ThreadGroup[];
  searchQuery: string;
  currentThreadId: string | undefined;
}

export function useCollapseState({ threadGroups, searchQuery, currentThreadId }: UseCollapseStateOptions) {
  const initialized = useRef(false);
  const allKnownKeys = useRef<Set<string>>(new Set());
  const lastAutoExpandedThreadId = useRef<string | undefined>(undefined);
  const lastAutoExpandedSearchQuery = useRef<string | undefined>(undefined);
  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set());
  const [searchExpanded, setSearchExpanded] = useState<Set<string>>(() => new Set());
  const [manualCollapsedDuringSearch, setManualCollapsedDuringSearch] = useState<Set<string>>(() => new Set());

  // Accumulate all ever-seen group keys (P1-1 fix: collapseAll needs full set)
  for (const g of threadGroups) {
    for (const key of getGroupKeys(g)) {
      allKnownKeys.current.add(key);
    }
  }

  // Initialize from localStorage once we know the group keys
  useEffect(() => {
    if (initialized.current) return;
    if (threadGroups.length === 0) return;
    const allKeys = getAllGroupKeys(threadGroups);
    setCollapsed(initCollapsedSet(allKeys, getStorage()));
    initialized.current = true;
  }, [threadGroups]);

  // Persist whenever collapsed state changes
  useEffect(() => {
    if (!initialized.current) return;
    writeCollapsedGroups([...collapsed], getStorage());
  }, [collapsed]);

  // Search reveals matching groups once per query; manual collapse still wins afterward.
  useEffect(() => {
    if (!initialized.current) return;
    if (searchQuery.length === 0) {
      lastAutoExpandedSearchQuery.current = undefined;
      setSearchExpanded((prev) => (prev.size === 0 ? prev : new Set()));
      setManualCollapsedDuringSearch((prev) => (prev.size === 0 ? prev : new Set()));
      return;
    }
    if (threadGroups.length === 0) return;
    const visibleKeys = getAllGroupKeys(threadGroups);
    if (lastAutoExpandedSearchQuery.current !== searchQuery) {
      lastAutoExpandedSearchQuery.current = searchQuery;
      setManualCollapsedDuringSearch(new Set());
      setSearchExpanded(new Set(visibleKeys));
      return;
    }
    setSearchExpanded((prev) => {
      const next = new Set(prev);
      let changed = false;
      for (const key of visibleKeys) {
        if (prev.has(key)) continue;
        next.add(key);
        changed = true;
      }
      return changed ? next : prev;
    });
  }, [searchQuery, threadGroups]);

  // Auto-expand group containing the current active thread
  useEffect(() => {
    // Reset guard when navigating away (including to undefined/"no thread"),
    // so returning to the same thread will auto-expand its group again.
    if (lastAutoExpandedThreadId.current && lastAutoExpandedThreadId.current !== currentThreadId) {
      lastAutoExpandedThreadId.current = undefined;
    }
    if (!currentThreadId || !initialized.current) return;
    if (lastAutoExpandedThreadId.current === currentThreadId) return;
    const groupsMeta = threadGroups.map((g) => ({
      groupKey: getGroupKey(g),
      threadIds: g.threads.map((t) => t.id),
      type: g.type,
    }));
    const key = findGroupKeyForThread(currentThreadId, groupsMeta);
    if (!key) return;
    const keysToExpand = [key];
    if (key === 'archived-container') {
      const archivedSubgroupKey = findArchivedSubgroupKeyForThread(currentThreadId, threadGroups);
      if (archivedSubgroupKey) keysToExpand.push(archivedSubgroupKey);
    }
    lastAutoExpandedThreadId.current = currentThreadId;
    setCollapsed((prev) => {
      if (keysToExpand.every((groupKey) => !prev.has(groupKey))) return prev;
      const next = new Set(prev);
      for (const groupKey of keysToExpand) {
        next.delete(groupKey);
      }
      return next;
    });
  }, [currentThreadId, threadGroups]);

  const isCollapsed = useCallback(
    (groupKey: string): boolean => {
      if (
        initialized.current &&
        searchQuery.length > 0 &&
        searchExpanded.has(groupKey) &&
        !manualCollapsedDuringSearch.has(groupKey)
      ) {
        return false;
      }
      return resolveCollapse(groupKey, collapsed, initialized.current);
    },
    [collapsed, manualCollapsedDuringSearch, searchExpanded, searchQuery],
  );

  const toggleGroup = useCallback(
    (groupKey: string) => {
      const shouldCollapse = !isCollapsed(groupKey);
      setCollapsed((prev) => {
        const next = new Set(prev);
        if (shouldCollapse) next.add(groupKey);
        else next.delete(groupKey);
        return next;
      });
      if (searchQuery.length === 0) return;
      if (!searchExpanded.has(groupKey)) return;
      setManualCollapsedDuringSearch((prev) => {
        const next = new Set(prev);
        if (shouldCollapse) next.add(groupKey);
        else next.delete(groupKey);
        return next;
      });
    },
    [isCollapsed, searchExpanded, searchQuery],
  );

  const expandAll = useCallback(() => {
    setCollapsed(expandAllGroups());
    setManualCollapsedDuringSearch((prev) => (prev.size === 0 ? prev : new Set()));
  }, []);

  // P1-1 fix: use allKnownKeys (accumulated), not filtered threadGroups
  const collapseAll = useCallback(() => {
    const keys = [...allKnownKeys.current];
    setCollapsed(collapseAllGroups(keys));
    if (searchQuery.length > 0) {
      setManualCollapsedDuringSearch(new Set(keys));
    }
  }, [searchQuery]);

  return { isCollapsed, toggleGroup, expandAll, collapseAll };
}
