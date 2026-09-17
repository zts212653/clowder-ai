'use client';

import { useEffect, useState } from 'react';
import { useChatStore } from '@/stores/chatStore';
import { apiFetch } from '@/utils/api-client';

type RetryState = 'loading' | 'failed' | 'running' | 'succeeded' | 'canceled' | 'unavailable' | 'submitted';

export function RoutingPreflightActions({ payload }: { payload: Record<string, unknown> }) {
  const openTeamSubject = useChatStore((state) => state.openTeamSubject);
  const target = payload.target as { disposition?: unknown } | undefined;
  const invocationId =
    target?.disposition === 'rejected' && typeof payload.retryInvocationId === 'string'
      ? payload.retryInvocationId
      : undefined;
  const [state, setState] = useState<RetryState>('loading');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [refresh, setRefresh] = useState(0);
  useEffect(() => {
    if (!invocationId) return;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    setState('loading');
    setError(null);
    const read = () =>
      void apiFetch(`/api/invocations/${encodeURIComponent(invocationId)}`, { signal: controller.signal })
        .then(async (response) => {
          if (!response.ok) throw new Error('暂时无法读取这条消息的状态');
          const record = (await response.json()) as { status?: unknown };
          if (controller.signal.aborted) return;
          setState(
            record.status === 'failed' || record.status === 'succeeded' || record.status === 'canceled'
              ? record.status
              : record.status === 'running' || record.status === 'queued'
                ? 'running'
                : 'unavailable',
          );
          if (record.status === 'running' || record.status === 'queued') {
            timer = setTimeout(read, 1_500);
          }
        })
        .catch((cause: unknown) => {
          if (controller.signal.aborted) return;
          setState('unavailable');
          setError(cause instanceof Error ? cause.message : '暂时无法读取这条消息的状态');
        });
    read();
    return () => {
      controller.abort();
      clearTimeout(timer);
    };
  }, [invocationId, refresh]);

  useEffect(() => {
    if (state !== 'submitted') return;
    const timer = setTimeout(() => setRefresh((value) => value + 1), 1_500);
    return () => clearTimeout(timer);
  }, [state]);

  const retry = async () => {
    if (!invocationId || busy || state !== 'failed') return;
    setBusy(true);
    setError(null);
    try {
      const response = await apiFetch(`/api/invocations/${encodeURIComponent(invocationId)}/retry`, { method: 'POST' });
      if (!response.ok) {
        const body = (await response.json().catch(() => null)) as { error?: string } | null;
        throw new Error(body?.error ?? '重试未能提交');
      }
      setState('submitted');
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '重试未能提交');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="mt-2 flex flex-wrap items-center gap-2 text-xs">
      {invocationId && state === 'failed' && (
        <button
          type="button"
          disabled={busy}
          className="rounded-md border border-default px-2 py-1 font-semibold text-primary disabled:opacity-50"
          onClick={() => void retry()}
        >
          {busy ? '正在提交…' : '重试这条'}
        </button>
      )}
      {invocationId && state === 'submitted' && <span role="status">已提交重试</span>}
      {invocationId && state === 'succeeded' && <span>这条已执行</span>}
      {invocationId && state === 'running' && <span>这条正在执行</span>}
      {invocationId && state === 'unavailable' && (
        <button type="button" className="underline" onClick={() => setRefresh((value) => value + 1)}>
          重新读取状态
        </button>
      )}
      <button
        type="button"
        className="rounded-md border border-default px-2 py-1 text-primary"
        onClick={() => openTeamSubject(null)}
      >
        查看其他成员
      </button>
      {error && (
        <span role="alert" className="text-conn-red-text">
          {error}
        </span>
      )}
    </div>
  );
}
