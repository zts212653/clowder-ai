'use client';

import {
  type Dispatch,
  type MutableRefObject,
  type SetStateAction,
  useCallback,
  useEffect,
  useRef,
  useState,
} from 'react';
import { API_URL, apiFetch } from '@/utils/api-client';

export type ConnectionLevel = 'online' | 'degraded' | 'offline';

interface ConnectionProbeState {
  api: ConnectionLevel;
  socket: ConnectionLevel;
  upstream: ConnectionLevel;
  browserOnline: boolean;
  isReadonly: boolean;
  checkedAt: number | null;
}

const POLL_INTERVAL_MS = 15_000;
const REQUEST_TIMEOUT_MS = 2_500;
const FAILURE_THRESHOLD = 2;

function getInitialBrowserOnline(): boolean {
  if (typeof navigator === 'undefined') return true;
  return navigator.onLine;
}

async function probePublicEndpoint(path: string): Promise<ConnectionLevel> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const res = await fetch(`${API_URL}${path}`, {
      cache: 'no-store',
      credentials: 'include',
      signal: controller.signal,
    });
    if (res.ok) return 'online';
    return 'degraded';
  } catch {
    return 'offline';
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Upstream probe: if roster is fetchable and at least one cat is routable, treat as online.
 * We use this as a low-cost proxy signal for "model side reachable enough to serve".
 */
async function probeCatsAvailability(): Promise<ConnectionLevel> {
  try {
    const res = await apiFetch('/api/cats');
    if (!res.ok) return 'degraded';
    const data = (await res.json().catch(() => null)) as { cats?: Array<{ roster?: { available?: boolean } }> } | null;
    const cats = Array.isArray(data?.cats) ? data.cats : [];
    if (cats.length === 0) return 'degraded';
    const hasRoutableCat = cats.some((cat) => cat?.roster?.available !== false);
    return hasRoutableCat ? 'online' : 'degraded';
  } catch {
    return 'offline';
  }
}

function mergeUpstreamSignal(ready: ConnectionLevel, cats: ConnectionLevel): ConnectionLevel {
  if (ready === 'offline' || cats === 'offline') return 'offline';
  if (ready === 'degraded' || cats === 'degraded') return 'degraded';
  return 'online';
}

export function useConnectionStatus(socketConnected?: boolean | null): ConnectionProbeState {
  const probesEnabled = process.env.NODE_ENV !== 'test';
  const [browserOnline, setBrowserOnline] = useState<boolean>(getInitialBrowserOnline);
  const [api, setApi] = useState<ConnectionLevel>(browserOnline ? 'online' : 'offline');
  const [upstream, setUpstream] = useState<ConnectionLevel>(browserOnline ? 'online' : 'offline');
  const [checkedAt, setCheckedAt] = useState<number | null>(null);
  const mountedRef = useRef(true);
  const apiFailureCountRef = useRef(0);
  const upstreamFailureCountRef = useRef(0);

  useEffect(() => {
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const applyWithFailureThreshold = useCallback(
    (
      next: ConnectionLevel,
      failureCountRef: MutableRefObject<number>,
      setter: Dispatch<SetStateAction<ConnectionLevel>>,
    ) => {
      if (next === 'online') {
        failureCountRef.current = 0;
        setter('online');
        return;
      }
      failureCountRef.current += 1;
      if (failureCountRef.current >= FAILURE_THRESHOLD) {
        setter(next);
      }
    },
    [],
  );

  const runProbe = useCallback(async () => {
    if (!browserOnline || !probesEnabled) return;
    const [apiLevel, readyLevel, catsLevel] = await Promise.all([
      probePublicEndpoint('/health'),
      probePublicEndpoint('/ready'),
      probeCatsAvailability(),
    ]);
    if (!mountedRef.current) return;

    applyWithFailureThreshold(apiLevel, apiFailureCountRef, setApi);
    applyWithFailureThreshold(mergeUpstreamSignal(readyLevel, catsLevel), upstreamFailureCountRef, setUpstream);
    setCheckedAt(Date.now());
  }, [applyWithFailureThreshold, browserOnline, probesEnabled]);

  useEffect(() => {
    if (!browserOnline) {
      apiFailureCountRef.current = 0;
      upstreamFailureCountRef.current = 0;
      setApi('offline');
      setUpstream('offline');
      setCheckedAt(Date.now());
      return;
    }

    if (!probesEnabled) {
      apiFailureCountRef.current = 0;
      upstreamFailureCountRef.current = 0;
      setApi('online');
      setUpstream('online');
      setCheckedAt(null);
      return;
    }

    void runProbe();
    const timer = setInterval(() => {
      void runProbe();
    }, POLL_INTERVAL_MS);
    return () => clearInterval(timer);
  }, [browserOnline, runProbe, probesEnabled]);

  useEffect(() => {
    if (typeof window === 'undefined') return;

    const handleOnline = () => {
      setBrowserOnline(true);
    };
    const handleOffline = () => {
      setBrowserOnline(false);
    };

    window.addEventListener('online', handleOnline);
    window.addEventListener('offline', handleOffline);
    return () => {
      window.removeEventListener('online', handleOnline);
      window.removeEventListener('offline', handleOffline);
    };
  }, []);

  const socket: ConnectionLevel = !browserOnline
    ? 'offline'
    : socketConnected == null
      ? 'online'
      : socketConnected
        ? 'online'
        : 'degraded';

  const isReadonly = !browserOnline || (api === 'offline' && socket === 'offline');

  return {
    api,
    socket,
    upstream,
    browserOnline,
    isReadonly,
    checkedAt,
  };
}
