'use client';
import type { GlobalArtifactDTO, MessageSearchResponse } from '@cat-cafe/shared';
import { useEffect, useMemo, useState } from 'react';
import type { MemorySearchData } from '@/components/memory/page/memory-search-types';
import { request } from './owner-api';

export function useCafeSearchBindings(
  works: { artifacts: GlobalArtifactDTO[]; loading: boolean; error: boolean | string | null },
  readWorks: (name: string, args: Record<string, string>) => Promise<unknown>,
  needed: boolean | number = false,
) {
  const [query, setQuery] = useState({ q: '', sort: 'time' });
  const [read, setRead] = useState({
    query: '',
    messages: null as MessageSearchResponse | null,
    memory: null as MemorySearchData | null,
    errors: { messages: null as unknown, memory: null as unknown },
  });
  useEffect(() => {
    if (!needed) return;
    const abort = new AbortController();
    setRead((current) =>
      current.query === query.q
        ? current
        : { query: query.q, messages: null, memory: null, errors: { messages: null, memory: null } },
    );
    if (query.q) {
      const params = new URLSearchParams({
        resultUnit: 'message',
        q: query.q,
        mode: 'hybrid',
        messageSort: query.sort,
      });
      void Promise.allSettled([
        request<MessageSearchResponse>(`/api/evidence/search?${params}`, { signal: abort.signal }),
        request<MemorySearchData>(
          `/api/memory/search?${new URLSearchParams({ q: query.q, type: 'memory', depth: 'summary', limit: '20' })}`,
          { signal: abort.signal },
        ),
      ]).then(([messages, memory]) => {
        if (!abort.signal.aborted)
          setRead({
            query: query.q,
            messages: messages.status === 'fulfilled' ? messages.value : null,
            memory: memory.status === 'fulfilled' ? memory.value : null,
            errors: {
              messages: messages.status === 'rejected' ? messages.reason : null,
              memory: memory.status === 'rejected' ? memory.reason : null,
            },
          });
      });
    }
    return () => abort.abort();
  }, [needed, query.q, query.sort]);
  const rawData = useMemo(() => ({ ...read, works }), [read, works]);
  return {
    data: rawData,
    action: async (name: string, args: Record<string, string>) => {
      if (name !== 'cafeSearchRead') return false;
      await readWorks(name, args);
      setQuery((current) =>
        current.q === args.q && current.sort === args.sort ? current : { q: args.q, sort: args.sort },
      );
      return true;
    },
  };
}
