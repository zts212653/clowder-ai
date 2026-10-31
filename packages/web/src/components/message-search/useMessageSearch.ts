import type { MessageSearchResponse } from '@cat-cafe/shared';
import { useCallback, useEffect, useRef, useState } from 'react';
import { apiFetch } from '@/utils/api-client';
import type { MessageFindState } from './message-find-state';

type SearchScope = 'thread' | 'global';
type SearchSort = 'time' | 'relevance';
type SearchStatus = 'idle' | 'loading' | 'ready' | 'error' | 'forbidden';

async function requestMessages(
  params: URLSearchParams,
  signal: AbortSignal,
): Promise<{ status: 'ready'; response: MessageSearchResponse } | { status: 'forbidden' | 'error' }> {
  try {
    const result = await apiFetch(`/api/evidence/search?${params}`, { signal });
    if (!result.ok) return { status: result.status === 401 || result.status === 403 ? 'forbidden' : 'error' };
    return { status: 'ready', response: await result.json() };
  } catch {
    return { status: 'error' };
  }
}

export function useMessageSearch(threadId: string, initialState?: MessageFindState) {
  const [status, setStatus] = useState<SearchStatus>(initialState?.status ?? 'idle');
  const [response, setResponse] = useState<MessageSearchResponse | undefined>(initialState?.response);
  const generation = useRef(0);
  const controller = useRef<AbortController>();
  const lastQuery = useRef<{ query: string; scope: SearchScope; sort: SearchSort } | undefined>(
    initialState ? { query: initialState.query, scope: initialState.scope, sort: initialState.sort } : undefined,
  );
  const previousThread = useRef(threadId);
  const currentThread = useRef(threadId);
  currentThread.current = threadId;

  // biome-ignore lint/correctness/useExhaustiveDependencies: the thread owns the request lifetime even before a query exists.
  useEffect(() => {
    if (previousThread.current !== threadId) {
      generation.current += 1;
      controller.current?.abort();
      lastQuery.current = undefined;
      setStatus('idle');
      setResponse(undefined);
      previousThread.current = threadId;
    }
    return () => {
      generation.current += 1;
      controller.current?.abort();
    };
  }, [threadId]);

  const search = useCallback(
    async (query: string, scope: SearchScope = 'thread', sort: SearchSort = 'time') => {
      const text = query.trim();
      if (!text) return;
      controller.current?.abort();
      const ownedController = new AbortController();
      controller.current = ownedController;
      const ownedGeneration = ++generation.current;
      const stale = () =>
        ownedGeneration !== generation.current || currentThread.current !== threadId || ownedController.signal.aborted;
      lastQuery.current = { query: text, scope, sort };
      setStatus('loading');
      setResponse(undefined);
      const params = new URLSearchParams({ resultUnit: 'message', q: text });
      if (scope === 'thread') params.set('threadId', threadId);
      params.set('messageSort', sort);
      params.set('mode', 'hybrid');
      const outcome = await requestMessages(params, ownedController.signal);
      if (stale()) return;
      setStatus(outcome.status);
      if (outcome.status === 'ready') setResponse(outcome.response);
    },
    [threadId],
  );

  const retry = useCallback(async () => {
    const previous = lastQuery.current;
    if (previous) await search(previous.query, previous.scope, previous.sort);
  }, [search]);
  return { status, response, search, retry };
}
