import {
  type EntrustedWorkOwnerReadV1,
  entrustedWorkOwnerReadV1Schema,
  producerAttentionCoverageV1Schema,
} from '@cat-cafe/shared';
import { useCallback, useEffect, useRef, useState } from 'react';
import { apiFetch } from '@/utils/api-client';

interface EntrustedWorkProjectionResult {
  ownerReads: EntrustedWorkOwnerReadV1[];
  loading: boolean;
  error: boolean;
  /** At least one producer failed; successful owner facts remain readable but absence/counts are not exact. */
  partial: boolean;
  /** A confirmed snapshot exists for this same projection while revalidating. */
  confirmed: boolean;
  refetch: () => void;
}

export type EntrustedWorkProjection = 'schedule' | 'needs-me' | 'completed';

function projectionEndpoint(projection: EntrustedWorkProjection): string {
  if (projection === 'needs-me') return '/api/entrusted-work/needs-me';
  if (projection === 'completed') return '/api/entrusted-work/owner-reads?view=completed';
  return '/api/entrusted-work/owner-reads';
}

async function readProjection(
  projection: EntrustedWorkProjection,
  signal: AbortSignal,
): Promise<{ ownerReads: EntrustedWorkOwnerReadV1[]; partial: boolean }> {
  const response = await apiFetch(projectionEndpoint(projection), { signal }, { afterCurrentGet: true });
  if (!response.ok) throw new Error(`entrusted-work owner reads failed: ${response.status}`);
  const body = (await response.json()) as { ownerReads?: unknown; coverage?: unknown };
  const ownerReads = entrustedWorkOwnerReadV1Schema.array().parse(body.ownerReads);
  const coverage = producerAttentionCoverageV1Schema.parse(body.coverage);
  return {
    ownerReads,
    partial: coverage.state === 'partial' || ownerReads.some((read) => read.envelope.freshness.state !== 'current'),
  };
}

export function useEntrustedWorkProjection(
  projection: EntrustedWorkProjection = 'schedule',
): EntrustedWorkProjectionResult {
  const [ownerReads, setOwnerReads] = useState<EntrustedWorkOwnerReadV1[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const [partial, setPartial] = useState(false);
  const [resolution, setResolution] = useState<{
    projection: EntrustedWorkProjection;
    confirmed: boolean;
  } | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  const refetch = useCallback(async () => {
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    setLoading(true);
    setError(false);
    try {
      const result = await readProjection(projection, controller.signal);
      if (!controller.signal.aborted) {
        setOwnerReads(result.ownerReads);
        setPartial(result.partial);
        setResolution({ projection, confirmed: !result.partial });
      }
    } catch (reason: unknown) {
      if (controller.signal.aborted || (reason instanceof DOMException && reason.name === 'AbortError')) return;
      setOwnerReads([]);
      setPartial(false);
      setResolution({ projection, confirmed: false });
      setError(true);
    } finally {
      if (!controller.signal.aborted) {
        setLoading(false);
      }
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

  return {
    ownerReads,
    loading: loading || resolution?.projection !== projection,
    confirmed: resolution?.projection === projection && resolution.confirmed && !error,
    error,
    partial,
    refetch,
  };
}
