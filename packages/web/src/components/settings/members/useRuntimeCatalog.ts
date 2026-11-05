'use client';
import { useEffect, useMemo, useRef, useState } from 'react';
import { apiFetch } from '@/utils/api-client';
import type { MemberChoice } from './MemberChoicePicker';
export interface MemberCatalog {
  thinkingEnabled?: boolean;
  status: 'live' | 'configured' | 'unavailable';
  models: Array<MemberChoice & { efforts?: MemberChoice[]; resolvedModel?: string }>;
  defaultModel?: string;
  defaultModelLabel?: string;
  defaultModelStatus?: 'reported' | 'unreported' | 'unavailable';
  contextDelivery?: 'prompt_compatibility';
  defaultEffort?: string;
  defaultEffortLabel?: string;
  defaultModelSource?: 'tool_config' | 'client_report' | 'account_config';
  defaultEffortSource?: 'tool_config' | 'client_report' | 'account_config';
  selectedModel?: string;
  selectedEffort?: string;
  selectedEffortLabel?: string;
  selectedEffortSource?: 'tool_config' | 'client_report' | 'account_config';
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
  const plugin = runtimeId?.startsWith('plugin:');
  const requestedModel =
    runtimeId === 'dsh' ||
    runtimeId === 'pi' ||
    runtimeId === 'kimi' ||
    runtimeId === 'claude' ||
    runtimeId?.startsWith('acp:') ||
    plugin
      ? model
      : '';
  const key = JSON.stringify([runtimeId, catId, accountRef, requestedModel, customStartup]);
  const context = JSON.stringify([runtimeId, catId, accountRef, customStartup]);
  useEffect(() => {
    if (!runtimeId) {
      setLoading(false);
      return;
    }
    const controller = new AbortController();
    setLoading(true);
    const force = refresh !== lastRefresh.current;
    lastRefresh.current = refresh;
    apiFetch(
      plugin ? '/api/agent-providers/models' : '/api/cats/runtime-models',
      {
        method: 'POST',
        signal: controller.signal,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ...(plugin ? { ref: runtimeId } : { runtimeId, catId }),
          accountRef: accountRef || undefined,
          model: requestedModel || undefined,
          customStartup,
          refresh: force,
        }),
      },
      ...(plugin || runtimeId === 'dsh' || runtimeId === 'pi' || runtimeId.startsWith('acp:')
        ? ([{ mutationTimeoutMs: 60_000 }] as const)
        : ([] as const)),
    )
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
                    ...(previous.key === key
                      ? {}
                      : { selectedModel: undefined, selectedEffort: undefined, selectedEffortLabel: undefined }),
                    message: 'refresh_failed',
                    ...(previous.data.defaultModelStatus === undefined
                      ? {}
                      : {
                          defaultModel: undefined,
                          defaultModelLabel: undefined,
                          selectedModel: undefined,
                          selectedEffort: undefined,
                          selectedEffortLabel: undefined,
                          defaultEffort: undefined,
                          defaultEffortLabel: undefined,
                          defaultModelStatus: 'unreported' as const,
                        }),
                  }
                : { status: 'unavailable', models: [], message: 'discovery_failed' },
          }));
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [key, context, refresh, runtimeId, catId, accountRef, requestedModel, customStartup, plugin]);
  // Keep transitional metadata stable: publishing it must not retrigger a subscribed parent forever.
  const catalog = useMemo(
    () =>
      result?.key === key
        ? result.data
        : result?.context === context
          ? {
              ...result.data,
              status: 'configured' as const,
              effortOptions: undefined,
              selectedModel: undefined,
              selectedEffort: undefined,
              selectedEffortLabel: undefined,
            }
          : null,
    [result, key, context],
  );
  return {
    catalog,
    loading: !!runtimeId && (loading || result?.key !== key),
  };
}
