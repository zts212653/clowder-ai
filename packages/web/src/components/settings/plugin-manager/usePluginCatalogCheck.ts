'use client';

import type { PluginManagerListResponse } from '@cat-cafe/shared';
import { useCallback, useEffect, useRef, useState } from 'react';
import { apiFetch } from '@/utils/api-client';
import { fetchManagerList, responseError } from './plugin-manager-live-api';

export interface PluginCatalogCheckState {
  checking: boolean;
  checked: boolean;
  lastSuccessfulAt: number | null;
  failedSources: number;
  unavailable: boolean;
  incomplete?: boolean;
  checkedAt?: number;
  hasCatalogSnapshot?: boolean;
  message?: string;
}
export function usePluginCatalogCheck(commit: (snapshot: PluginManagerListResponse) => Promise<void>) {
  const [state, setState] = useState<PluginCatalogCheckState>({
    checking: false,
    checked: false,
    lastSuccessfulAt: null,
    failedSources: 0,
    unavailable: false,
  });
  const active = useRef(true);
  const pending = useRef<Promise<void> | null>(null);
  useEffect(() => {
    active.current = true;
    return () => {
      active.current = false;
    };
  }, []);
  const check = useCallback(() => {
    if (pending.current) return pending.current;
    const operation = async () => {
      setState((current) => ({ ...current, checking: true, message: undefined }));
      let failedSources = 0;
      let sourceFailure: string | undefined;
      let sourceCheckFailed = false;
      try {
        const response = await apiFetch('/api/plugin-manager/marketplaces/refresh', { method: 'POST' });
        if (!response.ok)
          throw new Error((await responseError(response, `插件仓库检查失败 (${response.status})`)).message);
        const body: { sources?: Array<{ status: string; error?: string }> } = await response.json();
        if (!Array.isArray(body.sources)) throw new Error('插件仓库检查结果无法确认');
        const failed = body.sources.filter((source) => source.status !== 'ready');
        failedSources = failed.length;
        sourceFailure =
          failed
            .map((source) => source.error)
            .filter(Boolean)
            .join('；') || undefined;
      } catch (error) {
        sourceCheckFailed = true;
        sourceFailure = error instanceof Error ? error.message : '插件仓库检查未完成';
      }
      try {
        const value = await fetchManagerList('', true);
        if (!active.current) return;
        const unavailable = value.catalog.status === 'unavailable';
        const fresh = value.catalog.status === 'fresh' && failedSources === 0 && !sourceCheckFailed;
        const catalog =
          !unavailable && (failedSources > 0 || sourceCheckFailed)
            ? { ...value.catalog, status: 'degraded' as const }
            : value.catalog;
        await commit({ ...value, catalog });
        if (!active.current) return;
        setState((current) => ({
          checking: false,
          checked: true,
          checkedAt: Date.now(),
          hasCatalogSnapshot: !unavailable || current.hasCatalogSnapshot,
          unavailable,
          incomplete: !fresh && !unavailable,
          failedSources,
          lastSuccessfulAt: fresh ? (value.catalog.refreshedAt ?? Date.now()) : current.lastSuccessfulAt,
          message: sourceFailure ?? value.catalog.message,
        }));
      } catch (error) {
        if (active.current)
          setState((current) => ({
            ...current,
            checking: false,
            checked: true,
            checkedAt: Date.now(),
            unavailable: true,
            failedSources,
            message: error instanceof Error ? error.message : '插件目录读不到',
          }));
      }
    };
    const promise = operation().finally(() => {
      if (pending.current === promise) pending.current = null;
    });
    pending.current = promise;
    return promise;
  }, [commit]);
  return { state, check };
}
