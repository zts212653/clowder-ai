'use client';
import { useEffect, useState } from 'react';
import { request } from './owner-api';

/** The log tails (运行日志) of the given services, read while a projection needs them. */
export function useServiceLogs(ids: string[], needed: boolean | number) {
  const [logs, setLogs] = useState<{ data: Record<string, string[]> | null; loading: boolean; error: unknown }>({
    data: null,
    loading: false,
    error: null,
  });
  const key = ids.join('\n');
  useEffect(() => {
    if (!needed || !key) return;
    const abort = new AbortController();
    setLogs((current) => ({ ...current, loading: true }));
    Promise.all(
      key
        .split('\n')
        .map((id) =>
          request<{ lines: string[] }>(`/api/services/${encodeURIComponent(id)}/logs`, { signal: abort.signal }).then(
            (r) => [id, r.lines] as const,
          ),
        ),
    ).then(
      (rows) => {
        if (!abort.signal.aborted) setLogs({ data: Object.fromEntries(rows), loading: false, error: null });
      },
      (error) => {
        if (!abort.signal.aborted) setLogs({ data: null, loading: false, error });
      },
    );
    return () => abort.abort();
  }, [needed, key]);
  return logs;
}
