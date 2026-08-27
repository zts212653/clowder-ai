'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { apiFetch } from '@/utils/api-client';

export interface SearchResult {
  path: string;
  line: number;
  content: string;
  contextBefore: string;
  contextAfter: string;
  matchType?: 'filename' | 'content';
}

type SearchMode = 'content' | 'filename' | 'all';
type SearchSingle = (query: string, type: Exclude<SearchMode, 'all'>) => Promise<SearchResult[]>;

async function collectSearchResults(searchSingle: SearchSingle, query: string, type: SearchMode) {
  if (type !== 'all') return searchSingle(query, type);
  const [filenameResults, contentResults] = await Promise.all([
    searchSingle(query, 'filename'),
    searchSingle(query, 'content'),
  ]);
  return [
    ...filenameResults.map((result) => ({ ...result, matchType: 'filename' as const })),
    ...contentResults.map((result) => ({ ...result, matchType: 'content' as const })),
  ];
}

export function useWorkspaceSearch(worktreeId: string | null) {
  const [results, setResults] = useState<SearchResult[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const requestSeq = useRef(0);

  const searchSingle = useCallback(
    async (query: string, type: 'content' | 'filename'): Promise<SearchResult[]> => {
      const response = await apiFetch('/api/workspace/search', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ worktreeId, query, type }),
      });
      if (!response.ok) {
        const data = await response.json().catch(() => ({ error: 'Failed to search workspace' }));
        throw new Error(data.error ?? 'Failed to search workspace');
      }
      const data = await response.json();
      return (data.results ?? []) as SearchResult[];
    },
    [worktreeId],
  );

  const reset = useCallback(() => {
    requestSeq.current += 1;
    setResults([]);
    setLoading(false);
    setError(null);
  }, []);

  const search = useCallback(
    async (query: string, type: SearchMode = 'content') => {
      const activeRequest = ++requestSeq.current;
      const trimmedQuery = query.trim();
      if (!worktreeId || !trimmedQuery) {
        setResults([]);
        setLoading(false);
        setError(null);
        return;
      }

      setLoading(true);
      setError(null);
      try {
        const nextResults = await collectSearchResults(searchSingle, trimmedQuery, type);
        if (activeRequest !== requestSeq.current) return;
        setResults(nextResults);
      } catch {
        if (activeRequest === requestSeq.current) {
          setResults([]);
          setError('Failed to search workspace');
        }
      } finally {
        if (activeRequest === requestSeq.current) setLoading(false);
      }
    },
    [searchSingle, worktreeId],
  );

  useEffect(() => {
    void worktreeId;
    reset();
  }, [reset, worktreeId]);

  return { results, loading, error, search, reset };
}
