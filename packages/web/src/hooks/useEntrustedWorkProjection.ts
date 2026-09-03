import { type EntrustedWorkOwnerReadV1, entrustedWorkOwnerReadV1Schema } from '@cat-cafe/shared';
import { useCallback, useEffect, useRef, useState } from 'react';
import { apiFetch } from '@/utils/api-client';

interface EntrustedWorkProjectionResult {
  ownerReads: EntrustedWorkOwnerReadV1[];
  loading: boolean;
  error: boolean;
  refetch: () => void;
}

export type EntrustedWorkProjection = 'schedule' | 'needs-me';

export function useEntrustedWorkProjection(
  projection: EntrustedWorkProjection = 'schedule',
): EntrustedWorkProjectionResult {
  const [ownerReads, setOwnerReads] = useState<EntrustedWorkOwnerReadV1[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const abortRef = useRef<AbortController | null>(null);

  const refetch = useCallback(async () => {
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    setLoading(true);
    setError(false);
    try {
      const endpoint = projection === 'needs-me' ? '/api/entrusted-work/needs-me' : '/api/entrusted-work/owner-reads';
      const response = await apiFetch(endpoint, { signal: controller.signal });
      if (!response.ok) throw new Error(`entrusted-work owner reads failed: ${response.status}`);
      const body = (await response.json()) as { ownerReads?: unknown };
      const parsed = entrustedWorkOwnerReadV1Schema.array().parse(body.ownerReads);
      if (!controller.signal.aborted) setOwnerReads(parsed);
    } catch (reason: unknown) {
      if (controller.signal.aborted || (reason instanceof DOMException && reason.name === 'AbortError')) return;
      setOwnerReads([]);
      setError(true);
    } finally {
      if (!controller.signal.aborted) setLoading(false);
    }
  }, [projection]);

  useEffect(() => {
    void refetch();
    const refresh = (): void => void refetch();
    window.addEventListener('cat-cafe:entrusted-work-projection-invalidated', refresh);
    window.addEventListener('cat-cafe:runtime-interaction-updated', refresh);
    return () => {
      window.removeEventListener('cat-cafe:entrusted-work-projection-invalidated', refresh);
      window.removeEventListener('cat-cafe:runtime-interaction-updated', refresh);
      abortRef.current?.abort();
    };
  }, [refetch]);

  return { ownerReads, loading, error, refetch };
}
