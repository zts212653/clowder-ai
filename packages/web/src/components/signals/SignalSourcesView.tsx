'use client';

import type { SignalSource } from '@cat-cafe/shared';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { fetchSignalSources, triggerSourceFetch, updateSignalSource } from '@/utils/signals-api';
import { SignalNav } from './SignalNav';

function SourceStatCard({ label, value, warning }: { label: string; value: number; warning?: boolean }) {
  return (
    <div
      className="flex flex-1 flex-col gap-1 rounded-2xl bg-[var(--console-card-bg)] p-4 shadow-[0_8px_22px_rgba(43,33,26,0.04)]"
      style={{ height: 92 }}
    >
      <span className={`text-[22px] font-bold ${warning ? 'text-conn-amber-text' : 'text-cafe'}`}>{value}</span>
      <span className="text-xs text-cafe-secondary">{label}</span>
    </div>
  );
}

function StatusPill({ enabled }: { enabled: boolean }) {
  return (
    <span
      className={`rounded-md px-2 py-0.5 text-[11px] font-medium ${enabled ? 'bg-conn-emerald-bg text-conn-emerald-text' : 'bg-conn-amber-bg text-conn-amber-text'}`}
    >
      {enabled ? '正常' : '需检查'}
    </span>
  );
}

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

  const stats = useMemo(() => {
    const total = sources.length;
    const abnormal = sources.filter((s) => !s.enabled).length;
    return { total, abnormal };
  }, [sources]);

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

  return (
    <div className="flex h-full flex-col bg-[var(--console-panel-bg)]">
      <div className="flex flex-1 flex-col overflow-hidden rounded-[18px] bg-[var(--console-shell-bg)] shadow-[var(--console-shadow-soft)] m-3 gap-5 px-9 py-8">
        <header className="flex items-center justify-between gap-4">
          <div>
            <h1 className="text-2xl font-bold text-cafe">信号源</h1>
            <p className="mt-1 text-[13px] text-cafe-secondary">管理抓取来源、优先级和健康状态</p>
          </div>
        </header>

        <div className="flex h-[38px] items-center gap-2">
          <SignalNav active="sources" initialReferrerThread={initialReferrerThread} />
        </div>

        <div className="flex gap-3.5">
          <SourceStatCard label="总信源" value={stats.total} />
          <SourceStatCard label="今日新增" value={0} />
          <SourceStatCard label="异常" value={stats.abnormal} warning={stats.abnormal > 0} />
        </div>

        {error && (
          <div className="console-status-chip" data-status="error">
            请求失败: {error}
          </div>
        )}
        {fetchResult && (
          <div
            className={`console-status-chip ${fetchResult.ok ? '' : ''}`}
            data-status={fetchResult.ok ? 'success' : 'error'}
          >
            <span className="font-semibold">{fetchResult.sourceId}</span>: {fetchResult.message}
          </div>
        )}

        <div className="flex-1 overflow-y-auto rounded-[18px] bg-[var(--console-panel-bg)] p-2 space-y-2">
          {loading && <p className="px-2 text-sm text-cafe-secondary">加载中...</p>}
          {!loading && sources.length === 0 && <p className="px-2 text-sm text-cafe-secondary">暂无信源</p>}
          {sources.map((source) => (
            <div
              key={source.id}
              className="flex items-center gap-3 rounded-[14px] bg-[var(--console-card-bg)] px-3 py-3.5"
            >
              <div className="flex h-[17px] w-[17px] shrink-0 items-center justify-center text-cafe-secondary">
                <svg className="h-full w-full" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <circle cx="12" cy="12" r="2" />
                  <path d="M16.24 7.76a6 6 0 010 8.49m-8.48-.01a6 6 0 010-8.49m11.31-2.82a10 10 0 010 14.14m-14.14 0a10 10 0 010-14.14" />
                </svg>
              </div>
              <span className="flex-1 truncate text-[13px] font-bold text-cafe">{source.name}</span>
              <StatusPill enabled={source.enabled} />
              <span
                className="rounded-lg bg-[var(--console-field-bg)] px-2.5 py-1 text-xs text-cafe-secondary"
                style={{ width: 96 }}
              >
                Tier {source.tier ?? 1}
              </span>
              <button
                type="button"
                disabled={fetchingIds.has(source.id)}
                onClick={() => void doFetch(source.id)}
                className="rounded-lg bg-[var(--console-field-bg)] px-2.5 py-1 text-xs font-semibold text-cafe-secondary transition-colors hover:text-cafe disabled:opacity-50"
              >
                {fetchingIds.has(source.id) ? '抓取中...' : 'Fetch'}
              </button>
              <button
                type="button"
                disabled={updatingId === source.id}
                onClick={() => void setEnabled(source.id, !source.enabled)}
                className={[
                  'rounded-lg px-2.5 py-1 text-xs font-semibold transition-colors',
                  source.enabled
                    ? 'bg-conn-emerald-bg text-conn-emerald-text'
                    : 'bg-[var(--console-field-bg)] text-cafe-secondary',
                ].join(' ')}
              >
                {updatingId === source.id ? '...' : source.enabled ? 'ON' : 'OFF'}
              </button>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
