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
  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set());

  // Accumulate all ever-seen group keys (P1-1 fix: collapseAll needs full set)
  for (const g of threadGroups) {
    allKnownKeys.current.add(getGroupKey(g));
  }

  // Initialize from localStorage once we know the group keys
  useEffect(() => {
    if (initialized.current) return;
    if (threadGroups.length === 0) return;
    const allKeys = threadGroups.map(getGroupKey);
    setCollapsed(initCollapsedSet(allKeys, getStorage()));
    initialized.current = true;
  }, [threadGroups]);

  // Persist whenever collapsed state changes
  useEffect(() => {
    if (!initialized.current) return;
    writeCollapsedGroups([...collapsed], getStorage());
  }, [collapsed]);

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
    lastAutoExpandedThreadId.current = currentThreadId;
    setCollapsed((prev) => {
      if (!prev.has(key)) return prev;
      const next = new Set(prev);
      next.delete(key);
      return next;
    });
  }, [currentThreadId, threadGroups]);

  const isCollapsed = useCallback(
    (groupKey: string): boolean => resolveCollapse(groupKey, collapsed, searchQuery, initialized.current),
    [collapsed, searchQuery],
  );

  const toggleGroup = useCallback((groupKey: string) => {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(groupKey)) next.delete(groupKey);
      else next.add(groupKey);
      return next;
    });
  }, []);

  const expandAll = useCallback(() => setCollapsed(expandAllGroups()), []);

  // P1-1 fix: use allKnownKeys (accumulated), not filtered threadGroups
  const collapseAll = useCallback(() => {
    setCollapsed(collapseAllGroups([...allKnownKeys.current]));
  }, []);

  return { isCollapsed, toggleGroup, expandAll, collapseAll };
}
