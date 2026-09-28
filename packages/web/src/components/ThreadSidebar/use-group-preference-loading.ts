'use client';

import { type MutableRefObject, useCallback, useEffect, useRef, useState } from 'react';
import { apiFetch } from '@/utils/api-client';
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
async function readPreferences(signal: AbortSignal): Promise<ThreadAttentionPreferences> {
  for (let attempt = 0; ; attempt += 1) {
    signal.throwIfAborted();
    try {
      const response = await apiFetch('/api/config/thread-attention', { signal });
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
    const promise = mutationQueue.current.then(async () => {
      if (controller.signal.aborted) return null;
      setLoad({ state: 'loading', failure: null });
      try {
        const preferences = await readPreferences(controller.signal);
        if (controller.signal.aborted) return null;
        accept(preferences);
        return preferences;
      } catch (error) {
        if (!controller.signal.aborted) setLoad({ state: 'error', failure: describeFailure(error) });
        return null;
      }
    });
    mutationQueue.current = promise.then(() => undefined);
    const flight = { controller, promise };
    inFlight.current = flight;
    void promise.then(() => {
      if (inFlight.current === flight) inFlight.current = null;
    });
    return promise;
  }, [accept, mutationQueue]);

  useEffect(() => {
    const controller = new AbortController();
    lifecycle.current = controller;
    void reload();
    return () => controller.abort();
  }, [reload]);

  useEffect(() => {
    if (load.state !== 'error' || !load.failure?.retryable) return;
    const recover = () => {
      if (navigator.onLine !== false) void reload();
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
  }, [load, reload]);

  return { groupLoadState: load.state, groupLoadError: load.failure?.message ?? null, reloadGroups: reload, accept };
}
