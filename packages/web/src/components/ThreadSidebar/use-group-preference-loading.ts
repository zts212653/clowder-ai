'use client';

import { type MutableRefObject, useCallback, useEffect, useRef, useState } from 'react';
import { apiFetch } from '@/utils/api-client';
import { THREAD_ATTENTION_INVALIDATED } from '@/utils/thread-attention-invalidation';
import type { ThreadAttentionPreferences } from './search-group-types';

class GroupReadFailure extends Error {
  constructor(
    message: string,
    readonly retryable: boolean,
  ) {
    super(message);
  }
}

function describeFailure(error: unknown): GroupReadFailure {
  if (error instanceof GroupReadFailure) return error;
  if (error instanceof Error && error.name === 'TimeoutError') {
    return new GroupReadFailure('读取 Group 超时 · 重试', true);
  }
  if (error instanceof TypeError) return new GroupReadFailure('暂时无法连接 Group · 重试', true);
  return new GroupReadFailure('读取 Group 失败 · 重试', false);
}

function waitToRetry(signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const cancel = () => {
      clearTimeout(timer);
      signal.removeEventListener('abort', cancel);
      reject(signal.reason);
    };
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', cancel);
      resolve();
    }, 1_000);
    signal.addEventListener('abort', cancel, { once: true });
    if (signal.aborted) cancel();
  });
}

/** One retry for transient failure; apiFetch still owns the 30s request bound. */
async function readPreferences(signal: AbortSignal, afterCurrentGet: boolean): Promise<ThreadAttentionPreferences> {
  for (let attempt = 0; ; attempt += 1) {
    signal.throwIfAborted();
    try {
      const response = await apiFetch('/api/config/thread-attention', { signal }, { afterCurrentGet });
      if (!response.ok) {
        throw new GroupReadFailure(
          '读取 Group 失败 · 重试',
          response.status >= 500 || response.status === 408 || response.status === 429,
        );
      }
      return (await response.json()) as ThreadAttentionPreferences;
    } catch (error) {
      signal.throwIfAborted();
      const failure = describeFailure(error);
      if (attempt >= 1 || !failure.retryable) throw failure;
      await waitToRetry(signal);
    }
  }
}

/** Reads share the existing writer queue, so a late GET cannot roll back a saved preference. */
export function useGroupPreferenceLoading(
  onLoaded: (preferences: ThreadAttentionPreferences) => void,
  mutationQueue: MutableRefObject<Promise<void>>,
) {
  const [load, setLoad] = useState<{
    state: 'loading' | 'ready' | 'error';
    failure: GroupReadFailure | null;
  }>({ state: 'loading', failure: null });
  const lifecycle = useRef<AbortController | null>(null);
  const invalidationVersion = useRef(0);
  const inFlight = useRef<{
    controller: AbortController;
    promise: Promise<ThreadAttentionPreferences | null>;
  } | null>(null);

  const accept = useCallback(
    (preferences: ThreadAttentionPreferences) => {
      onLoaded(preferences);
      setLoad({ state: 'ready', failure: null });
    },
    [onLoaded],
  );

  const reload = useCallback(() => {
    const controller = lifecycle.current;
    if (!controller || controller.signal.aborted) return Promise.resolve(null);
    if (inFlight.current?.controller === controller) return inFlight.current.promise;
    const promise: Promise<ThreadAttentionPreferences | null> = mutationQueue.current.then(async () => {
      try {
        if (controller.signal.aborted) return null;
        setLoad({ state: 'loading', failure: null });
        for (;;) {
          const version = invalidationVersion.current;
          try {
            const preferences = await readPreferences(controller.signal, version > 0);
            if (controller.signal.aborted) return null;
            if (version !== invalidationVersion.current) continue;
            accept(preferences);
            return preferences;
          } catch (error) {
            if (controller.signal.aborted) return null;
            if (version !== invalidationVersion.current) continue;
            setLoad({ state: 'error', failure: describeFailure(error) });
            return null;
          }
        }
      } finally {
        // Check, apply and release in one synchronous turn. A later hint starts a new queued read.
        if (inFlight.current === flight) inFlight.current = null;
      }
    });
    mutationQueue.current = promise.then(() => undefined);
    const flight = { controller, promise };
    inFlight.current = flight;
    return promise;
  }, [accept, mutationQueue]);

  const invalidate = useCallback(() => {
    invalidationVersion.current += 1;
    void reload();
  }, [reload]);

  useEffect(() => {
    const controller = new AbortController();
    lifecycle.current = controller;
    void reload();
    return () => controller.abort();
  }, [reload]);

  useEffect(() => {
    const approved = (event: Event) => {
      const proposal = (event as CustomEvent<{ status?: string; createdThreadId?: string }>).detail;
      if (proposal?.status === 'approved' && proposal.createdThreadId) invalidate();
    };
    window.addEventListener('cat-cafe:proposal-updated', approved);
    window.addEventListener('cat-cafe:socket-reconnected', invalidate);
    window.addEventListener(THREAD_ATTENTION_INVALIDATED, invalidate);
    return () => {
      window.removeEventListener('cat-cafe:proposal-updated', approved);
      window.removeEventListener('cat-cafe:socket-reconnected', invalidate);
      window.removeEventListener(THREAD_ATTENTION_INVALIDATED, invalidate);
    };
  }, [invalidate]);

  useEffect(() => {
    const recover = () => {
      if (navigator.onLine !== false && (load.state !== 'error' || load.failure?.retryable)) invalidate();
    };
    const visible = () => {
      if (document.visibilityState === 'visible') recover();
    };
    window.addEventListener('online', recover);
    window.addEventListener('focus', recover);
    document.addEventListener('visibilitychange', visible);
    return () => {
      window.removeEventListener('online', recover);
      window.removeEventListener('focus', recover);
      document.removeEventListener('visibilitychange', visible);
    };
  }, [load, invalidate]);

  return { groupLoadState: load.state, groupLoadError: load.failure?.message ?? null, reloadGroups: reload, accept };
}
