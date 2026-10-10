'use client';
import { useEffect, useRef, useState } from 'react';
import { apiFetch } from '@/utils/api-client';
import type { MemberChoice } from './MemberChoicePicker';
export interface MemberCatalog {
  status: 'live' | 'configured' | 'unavailable';
  models: Array<MemberChoice & { efforts?: MemberChoice[] }>;
  defaultModel?: string;
  defaultModelLabel?: string;
  defaultEffort?: string;
  selectedModel?: string;
  effortOptions?: MemberChoice[];
  message?: string;
}
export function useRuntimeCatalog(
  runtimeId: string | undefined,
  catId: string | undefined,
  accountRef: string,
  model: string,
  refresh: number,
  customStartup = false,
) {
  const lastRefresh = useRef(refresh);
  const [result, setResult] = useState<{ key: string; context: string; data: MemberCatalog } | null>(null),
    [loading, setLoading] = useState(false);
  const requestedModel = runtimeId?.startsWith('acp:') ? model : '';
  const key = JSON.stringify([runtimeId, catId, accountRef, requestedModel, customStartup]);
  const context = JSON.stringify([runtimeId, catId, accountRef, customStartup]);
  useEffect(() => {
    if (!runtimeId) return;
    const controller = new AbortController();
    setLoading(true);
    const force = refresh !== lastRefresh.current;
    lastRefresh.current = refresh;
    apiFetch('/api/cats/runtime-models', {
      method: 'POST',
      signal: controller.signal,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        runtimeId,
        catId,
        accountRef: accountRef || undefined,
        model: requestedModel || undefined,
        customStartup,
        refresh: force,
      }),
    })
      .then(async (response) => {
        if (!response.ok) throw Error('catalog');
        return (await response.json()) as MemberCatalog;
      })
      .then((data) => {
        if (!controller.signal.aborted)
          setResult((previous) => ({
            key,
            context,
            data: {
              ...data,
              models: data.models.length ? data.models : previous?.context === context ? previous.data.models : [],
            },
          }));
      })
      .catch(() => {
        if (!controller.signal.aborted)
          setResult((previous) => ({
            key,
            context,
            data:
              previous?.context === context
                ? {
                    ...previous.data,
                    status: 'configured',
                    effortOptions: previous.key === key ? previous.data.effortOptions : undefined,
                    message: 'refresh_failed',
                  }
                : { status: 'unavailable', models: [], message: 'discovery_failed' },
          }));
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [key, context, refresh, runtimeId, catId, accountRef, requestedModel, customStartup]);
  return {
    catalog:
      result?.key === key
        ? result.data
        : result?.context === context
          ? { ...result.data, status: 'configured' as const, effortOptions: undefined }
          : null,
    loading: !!runtimeId && (loading || result?.key !== key),
  };
}
