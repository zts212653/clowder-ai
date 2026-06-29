'use client';

import { useEffect, useMemo, useState } from 'react';
import type { Thread } from '@/stores/chat-types';
import { useChatStore } from '@/stores/chatStore';
import { apiFetch } from '@/utils/api-client';
import { getProjectPaths } from '../ThreadSidebar/thread-utils';

/**
 * Shared hook: assembles the known-project list from three sources.
 *
 * 1. chatStore threads (populated when ThreadSidebar is mounted)
 * 2. /api/threads fetch (fallback — Settings page doesn't mount ThreadSidebar)
 * 3. Server-reported paths (caller passes via `serverPaths`)
 *
 * Returns a deduplicated, normalized array.
 */
export function useKnownProjects(serverPaths: string[]): string[] {
  const [threadProjectPaths, setThreadProjectPaths] = useState<string[]>([]);
  const storeThreads = useChatStore((state) => state.threads);
  const storeProjects = useMemo(() => getProjectPaths(storeThreads), [storeThreads]);

  // Settings page doesn't mount ThreadSidebar, so useChatStore may return [].
  // Fetch /api/threads directly on mount to get thread-derived project paths.
  useEffect(() => {
    let cancelled = false;
    void apiFetch('/api/threads')
      .then(async (res) => {
        if (cancelled || !res.ok) return;
        const data = (await res.json()) as { threads: Thread[] };
        if (cancelled) return;
        setThreadProjectPaths(getProjectPaths(data.threads));
      })
      .catch(() => {
        /* non-critical: project dropdown degrades to fewer entries */
      });
    return () => {
      cancelled = true;
    };
  }, []);

  return useMemo(() => {
    const normalize = (p: string) => p.replace(/\/+$/, '');
    const seen = new Set<string>();
    const merged: string[] = [];
    const addUnique = (p: string) => {
      const key = normalize(p);
      if (!seen.has(key)) {
        seen.add(key);
        merged.push(p);
      }
    };
    for (const p of storeProjects) addUnique(p);
    for (const p of threadProjectPaths) addUnique(p);
    for (const p of serverPaths) addUnique(p);
    return merged;
  }, [storeProjects, threadProjectPaths, serverPaths]);
}
