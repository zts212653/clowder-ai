'use client';
import { useEffect, useMemo, useState } from 'react';
import { apiFetch } from '@/utils/api-client';
import { isMemorySearchData, type MemorySearchData, type SearchType } from './memory-search-types';

export function useMemorySearch(
  initialQuery?: string,
  initialType: SearchType = 'all',
  initialDepth: 'summary' | 'raw' = 'summary',
) {
  const initial = initialQuery?.trim() ?? '';
  const [input, setInput] = useState(initial);
  const [query, setQuery] = useState<string | null>(initial || null);
  const [type, updateType] = useState<SearchType>(initialType);
  const [depth, updateDepth] = useState<'summary' | 'raw'>(initialDepth);
  const [attempt, setAttempt] = useState(0);
  // biome-ignore lint/correctness/useExhaustiveDependencies: A server navigation may reuse this component with new route props; reread its current URL then.
  useEffect(() => {
    const pathname = window.location.pathname;
    const restore = (event?: PopStateEvent) => {
      if (window.location.pathname !== pathname) return;
      const params = new URLSearchParams(window.location.search);
      const restored = params.get('q')?.trim() ?? '';
      const scope = params.get('type');
      setInput(restored);
      setQuery(restored || null);
      updateType(scope === 'memory' || scope === 'documents' || scope === 'conversations' ? scope : 'all');
      updateDepth(params.get('depth') === 'raw' ? 'raw' : 'summary');
      if (event) setAttempt((value) => value + 1);
    };
    restore();
    window.addEventListener('popstate', restore);
    return () => window.removeEventListener('popstate', restore);
  }, [initial, initialType, initialDepth]);
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
  const setType = (value: SearchType) => {
    updateType(value);
    writeSearchLocation(query, value, depth);
  };
  const setDepth = (value: 'summary' | 'raw') => {
    updateDepth(value);
    writeSearchLocation(query, type, value);
  };
  const submit = () => {
    if (input.trim()) {
      setQuery(input.trim());
      writeSearchLocation(input.trim(), type, depth);
      retry();
    }
  };
  const close = () => {
    setQuery(null);
    setInput('');
    writeSearchLocation(null, type, depth);
  };
  const read = !request || state.request !== request ? { data: null, loading: !!request, error: false } : state;
  return { input, setInput, query, type, setType, depth, setDepth, submit, close, read: { ...read, retry } };
}
export type MemorySearchController = ReturnType<typeof useMemorySearch>;

/** Keep find conditions in this history entry; a return rereads sources instead of reviving old results. */
function writeSearchLocation(query: string | null, type: SearchType, depth: 'summary' | 'raw') {
  const url = new URL(window.location.href);
  for (const [key, value] of Object.entries({ q: query, type: query ? type : null, depth: query ? depth : null })) {
    if (value === null) url.searchParams.delete(key);
    else url.searchParams.set(key, value);
  }
  // Next copies its navigation state for a native history update. Do not send a server
  // navigation whose delayed props could overwrite a newer input or reopen a closed query.
  window.history.replaceState(null, '', `${url.pathname}${url.search}${url.hash}`);
}

function validateGroups(body: MemorySearchData, type: SearchType) {
  const expected = type === 'all' ? ['memory', 'documents', 'conversations'] : [type];
  if (body.groups.length !== expected.length || !expected.every((t) => body.groups.some((g) => g.type === t)))
    throw new Error('Incomplete search projection');
}
