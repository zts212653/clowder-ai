'use client';

import type { RoutingContextReadModelV1 } from '@cat-cafe/shared';
import { useCallback, useEffect, useRef, useState } from 'react';
import { fetchRoutingContext } from './routing-context-client';

export interface RoutingContextQueryState {
  data: RoutingContextReadModelV1 | null;
  loading: boolean;
  error: string | null;
  /**
   * Resolves to false when the read failed. Callers that just mutated routing truth
   * need this: keeping the previous snapshot on screen is fine, silently presenting
   * it as the post-write state is not.
   */
  refresh: () => Promise<boolean>;
}

export function useRoutingContext(): RoutingContextQueryState {
  const [data, setData] = useState<RoutingContextReadModelV1 | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const mounted = useRef(true);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const next = await fetchRoutingContext();
      if (mounted.current) setData(next);
      return true;
    } catch (cause) {
      if (mounted.current) setError(cause instanceof Error ? cause.message : 'Routing context 暂时无法读取');
      return false;
    } finally {
      if (mounted.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    mounted.current = true;
    void refresh();
    return () => {
      mounted.current = false;
    };
  }, [refresh]);

  return { data, loading, error, refresh };
}
