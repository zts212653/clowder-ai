'use client';
import { useEffect, useMemo, useState } from 'react';
import { apiFetch } from '@/utils/api-client';
import { isMemorySearchData, type MemorySearchData, type SearchType } from './memory-search-types';

export function useMemorySearch(initialQuery?: string) {
  const initial = initialQuery?.trim() ?? '';
  const [input, setInput] = useState(initial);
  const [query, setQuery] = useState<string | null>(initial || null);
  const [type, setType] = useState<SearchType>('all');
  const [depth, setDepth] = useState<'summary' | 'raw'>('summary');
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    setInput(initial);
    setQuery(initial || null);
    setType('all');
    setDepth('summary');
  }, [initial]);
  const request = useMemo(
    () => (query === null ? null : { query, type, depth, attempt }),
    [query, type, depth, attempt],
  );
  const [state, setState] = useState({ request, data: null as MemorySearchData | null, loading: false, error: false });
  useEffect(() => {
    if (!request) return;
    let active = true;
    const controller = new AbortController();
    setState({ request, data: null, loading: true, error: false });
    const params = new URLSearchParams({ q: request.query, type: request.type, depth: request.depth });
    apiFetch(`/api/memory/search?${params}`, { signal: controller.signal })
      .then(async (response) => {
        if (!response.ok) throw new Error('Search unavailable');
        const body: unknown = await response.json();
        if (!isMemorySearchData(body) || body.query !== request.query) throw new Error('Invalid search');
        validateGroups(body, request.type);
        if (active) setState({ request, data: body, loading: false, error: false });
      })
      .catch(() => {
        if (active) setState({ request, data: null, loading: false, error: true });
      });
    return () => {
      active = false;
      controller.abort();
    };
  }, [request]);
  const retry = () => setAttempt((n) => n + 1);
  const submit = () => {
    if (input.trim()) {
      setQuery(input.trim());
      retry();
    }
  };
  const close = () => {
    setQuery(null);
    setInput('');
  };
  const read = !request || state.request !== request ? { data: null, loading: !!request, error: false } : state;
  return { input, setInput, query, type, setType, depth, setDepth, submit, close, read: { ...read, retry } };
}
export type MemorySearchController = ReturnType<typeof useMemorySearch>;

function validateGroups(body: MemorySearchData, type: SearchType) {
  const expected = type === 'all' ? ['memory', 'documents', 'conversations'] : [type];
  if (body.groups.length !== expected.length || !expected.every((t) => body.groups.some((g) => g.type === t)))
    throw new Error('Incomplete search projection');
}
