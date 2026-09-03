'use client';

import type { RoutingContextReadModelV1 } from '@cat-cafe/shared';
import { useCallback, useEffect, useRef, useState } from 'react';
import { fetchRoutingContext } from './routing-context-client';

export interface RoutingContextQueryState {
  data: RoutingContextReadModelV1 | null;
  loading: boolean;
  error: string | null;
  refresh: () => Promise<void>;
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
    } catch (cause) {
      if (mounted.current) setError(cause instanceof Error ? cause.message : 'Routing context 暂时无法读取');
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
