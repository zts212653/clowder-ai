'use client';

import type { SignalSource } from '@cat-cafe/shared';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { fetchSignalSources, triggerSourceFetch, updateSignalSource } from '@/utils/signals-api';
import { groupSignalSourcesByTierAndCategory } from '@/utils/signals-view';
import { SignalNav } from './SignalNav';
import { SignalTierBadge } from './SignalTierBadge';

export function SignalSourcesView({ initialReferrerThread = null }: { initialReferrerThread?: string | null }) {
  const [sources, setSources] = useState<readonly SignalSource[]>([]);
  const [loading, setLoading] = useState(true);
  const [updatingId, setUpdatingId] = useState<string | null>(null);
  const [fetchingIds, setFetchingIds] = useState<ReadonlySet<string>>(new Set());
  const [fetchResult, setFetchResult] = useState<{ sourceId: string; message: string; ok: boolean } | null>(null);
  const [error, setError] = useState<string | null>(null);

  const reloadSources = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await fetchSignalSources();
      setSources(data);
    } catch (fetchError) {
      setError(fetchError instanceof Error ? fetchError.message : '加载信源失败');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void reloadSources();
  }, [reloadSources]);

  const groupedSources = useMemo(() => groupSignalSourcesByTierAndCategory(sources), [sources]);

  const setEnabled = useCallback(async (sourceId: string, enabled: boolean) => {
    setError(null);
    setUpdatingId(sourceId);
    try {
      const updated = await updateSignalSource(sourceId, enabled);
      setSources((current) => current.map((source) => (source.id === sourceId ? updated : source)));
    } catch (updateError) {
      setError(updateError instanceof Error ? updateError.message : '更新信源失败');
    } finally {
      setUpdatingId(null);
    }
  }, []);

  const doFetch = useCallback(async (sourceId: string) => {
    setError(null);
    setFetchResult(null);
    setFetchingIds((prev) => new Set([...prev, sourceId]));
    try {
      const result = await triggerSourceFetch(sourceId);
      const { summary } = result;
      const hasErrors = summary.errors.length > 0;
      const msg = hasErrors
        ? `Fetch 失败: ${summary.errors[0]?.message ?? 'unknown error'}`
        : `抓取 ${summary.fetchedArticles} 篇，新增 ${summary.newArticles} 篇，去重 ${summary.duplicateArticles} 篇`;
      setFetchResult({ sourceId, message: msg, ok: !hasErrors });
    } catch (fetchError) {
      setFetchResult({
        sourceId,
        message: fetchError instanceof Error ? fetchError.message : '抓取请求失败',
        ok: false,
      });
    } finally {
      setFetchingIds((prev) => {
        const next = new Set(prev);
        next.delete(sourceId);
        return next;
      });
    }
  }, []);

  const setAllEnabled = useCallback(
    async (enabled: boolean) => {
      const targets = sources.filter((source) => source.enabled !== enabled);
      for (const source of targets) {
        await setEnabled(source.id, enabled);
      }
    },
    [setEnabled, sources],
  );

  return (
    <div className="min-h-screen bg-gradient-to-b from-codex-bg/30 via-cafe-white to-cafe-white">
      <main className="mx-auto flex w-full max-w-7xl flex-col gap-4 px-4 py-5 sm:px-6">
        <header className="rounded-2xl border border-codex-light bg-cafe-surface p-4 shadow-sm">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <h1 className="text-xl font-bold text-cafe-black">Signal Sources</h1>
              <p className="text-sm text-cafe-secondary">集中管理信号源开关，无需手改 yaml。</p>
            </div>
            <SignalNav active="sources" initialReferrerThread={initialReferrerThread} />
          </div>
        </header>

        <section className="flex flex-wrap gap-2">
          <button
            type="button"
            onClick={() => void setAllEnabled(true)}
            className="rounded-lg border border-codex-light px-3 py-2 text-sm text-codex-dark hover:bg-codex-bg"
          >
            全部开启
          </button>
          <button
            type="button"
            onClick={() => void setAllEnabled(false)}
            className="rounded-lg border border-cafe px-3 py-2 text-sm text-cafe-secondary hover:bg-cafe-surface-elevated"
          >
            全部关闭
          </button>
          <button
            type="button"
            onClick={() => void reloadSources()}
            className="rounded-lg border border-cocreator-light px-3 py-2 text-sm text-cocreator-dark hover:bg-cocreator-bg"
          >
            刷新
          </button>
        </section>

        {error && (
          <div className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
            请求失败: {error}
          </div>
        )}
        {fetchResult && (
          <div
            className={[
              'rounded-lg border px-3 py-2 text-sm',
              fetchResult.ok ? 'border-green-200 bg-green-50 text-green-700' : 'border-red-200 bg-red-50 text-red-700',
            ].join(' ')}
          >
            <span className="font-semibold">{fetchResult.sourceId}</span>: {fetchResult.message}
          </div>
        )}
        {loading && <p className="text-sm text-cafe-secondary">加载中...</p>}

        <section className="space-y-4">
          {groupedSources.map((group) => (
            <div
              key={`${group.tier}-${group.category}`}
              className="rounded-2xl border border-cafe bg-cafe-surface p-4 shadow-sm"
            >
              <div className="mb-3 flex items-center gap-2">
                <SignalTierBadge tier={group.tier} />
                <h2 className="text-sm font-semibold text-cafe-black">{group.category}</h2>
                <span className="text-xs text-cafe-secondary">({group.sources.length})</span>
              </div>
              <ul className="space-y-2">
                {group.sources.map((source) => (
                  <li key={source.id} className="rounded-xl border border-cafe p-3">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <div className="min-w-0">
                        <p className="text-sm font-semibold text-cafe-black">{source.name}</p>
                        <div className="mt-0.5 flex flex-wrap items-center gap-2">
                          <a
                            href={source.url}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="break-all text-xs text-blue-600 hover:underline"
                          >
                            {source.url}
                          </a>
                          <a
                            href={source.url}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="rounded-md border border-opus-light px-2 py-0.5 text-[11px] text-opus-dark hover:bg-opus-bg"
                          >
                            访问 ↗
                          </a>
                        </div>
                        <p className="mt-1 text-xs text-cafe-secondary">
                          {source.fetch.method} · {source.schedule.frequency}
                        </p>
                      </div>
                      <div className="flex items-center gap-2">
                        <button
                          type="button"
                          disabled={fetchingIds.has(source.id)}
                          onClick={() => void doFetch(source.id)}
                          className="rounded-full border border-opus-light px-3 py-1 text-xs font-semibold text-opus-dark transition-colors hover:bg-opus-bg disabled:opacity-50"
                        >
                          {fetchingIds.has(source.id) ? '抓取中...' : 'Fetch'}
                        </button>
                        <button
                          type="button"
                          disabled={updatingId === source.id}
                          onClick={() => void setEnabled(source.id, !source.enabled)}
                          className={[
                            'rounded-full border px-3 py-1 text-xs font-semibold transition-colors',
                            source.enabled
                              ? 'border-codex-light bg-codex-bg text-codex-dark'
                              : 'border-cafe bg-cafe-surface-elevated text-cafe-secondary',
                          ].join(' ')}
                        >
                          {updatingId === source.id ? '更新中...' : source.enabled ? 'ON' : 'OFF'}
                        </button>
                      </div>
                    </div>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </section>
      </main>
    </div>
  );
}
