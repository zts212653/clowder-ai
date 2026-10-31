'use client';
import { useCallback, useEffect, useRef, useState } from 'react';
import { apiFetch } from '@/utils/api-client';
import { isRecallPage, type MemoryRecallPageData } from './recall-page-types';

function mergeRecallPages(previous: MemoryRecallPageData, next: MemoryRecallPageData): MemoryRecallPageData {
  const records = new Map(previous.records.map((row) => [JSON.stringify([row.threadId, row.event.id]), row]));
  for (const row of next.records) {
    const key = JSON.stringify([row.threadId, row.event.id]);
    if (!records.has(key)) records.set(key, row);
  }
  const replies = new Map(
    [...previous.replies, ...next.replies].map((reply) => [JSON.stringify([reply.threadId, reply.messageId]), reply]),
  );
  return {
    ...next,
    readStatus: previous.readStatus === 'partial' || next.readStatus === 'partial' ? 'partial' : 'ready',
    records: [...records.values()],
    replies: [...replies.values()],
    replyCursors: { ...previous.replyCursors, ...next.replyCursors },
  };
}
function isRecallContinuation(
  body: unknown,
  previous: MemoryRecallPageData,
  cursor: string,
): body is MemoryRecallPageData {
  return (
    isRecallPage(body) &&
    body.days === previous.days &&
    body.from === previous.from &&
    body.to === previous.to &&
    body.nextCursor !== cursor
  );
}
async function readRecallContinuation(
  path: string,
  previous: MemoryRecallPageData,
  cursor: string,
  signal: AbortSignal,
) {
  const response = await apiFetch(`${path}&cursor=${encodeURIComponent(cursor)}`, { signal });
  if (!response.ok) throw new Error('Recall page unavailable');
  const body: unknown = await response.json();
  if (!isRecallContinuation(body, previous, cursor)) throw new Error('Invalid recall continuation');
  return body;
}
export function useMemoryRecall(days: number, source: string, catId: string) {
  const path = `/api/memory/recall?days=${days}&source=${source}${catId ? `&catId=${encodeURIComponent(catId)}` : ''}`;
  const [attempt, setAttempt] = useState(0);
  const generation = `${path}:${attempt}`;
  const pending = {
    data: null as MemoryRecallPageData | null,
    loading: true,
    error: false,
    moreLoading: false,
    moreError: false,
  };
  const [state, setState] = useState({
    generation,
    data: null as MemoryRecallPageData | null,
    loading: true,
    error: false,
    moreLoading: false,
    moreError: false,
  });
  const visible = state.generation === generation ? state : pending;
  const run = useRef<{ controller: AbortController } | null>(null);
  const inFlight = useRef(false);
  const retry = useCallback(() => setAttempt((n) => n + 1), []);
  useEffect(() => {
    const current = { controller: new AbortController() };
    run.current = current;
    inFlight.current = false;
    let active = true;
    setState({ generation, data: null, loading: true, error: false, moreLoading: false, moreError: false });
    apiFetch(path, { signal: current.controller.signal })
      .then(async (response) => {
        if (!response.ok) throw new Error('Recall unavailable');
        const body: unknown = await response.json();
        if (!isRecallPage(body) || body.days !== days) throw new Error('Invalid recall page');
        if (active)
          setState({ generation, data: body, loading: false, error: false, moreLoading: false, moreError: false });
      })
      .catch(() => {
        if (active)
          setState({ generation, data: null, loading: false, error: true, moreLoading: false, moreError: false });
      });
    return () => {
      active = false;
      current.controller.abort();
    };
  }, [path, days, generation]);
  const loadMore = async () => {
    const current = run.current;
    const previousPage = visible.data;
    const cursor = previousPage?.nextCursor;
    if (!current || !previousPage || !cursor || inFlight.current || visible.loading) return;
    inFlight.current = true;
    const isCurrent = () => run.current === current && !current.controller.signal.aborted;
    setState((previous) => ({ ...previous, moreLoading: true, moreError: false }));
    try {
      const body = await readRecallContinuation(path, previousPage, cursor, current.controller.signal);
      if (!isCurrent()) return;
      setState((previous) => ({
        ...previous,
        moreLoading: false,
        moreError: false,
        data: previous.data ? mergeRecallPages(previous.data, body) : previous.data,
      }));
    } catch {
      if (isCurrent()) setState((previous) => ({ ...previous, moreLoading: false, moreError: true }));
    } finally {
      if (run.current === current) inFlight.current = false;
    }
  };
  return { ...visible, retry, loadMore, generation };
}
