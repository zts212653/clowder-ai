'use client';

import {
  type Dispatch,
  type MutableRefObject,
  type SetStateAction,
  useCallback,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react';
import { API_URL, apiFetch } from '@/utils/api-client';
import { type DeploymentRevisionState, pageDeploymentRevision } from '@/utils/deployment-revision';

export type ConnectionLevel = 'online' | 'degraded' | 'offline';

interface ConnectionProbeState {
  api: ConnectionLevel;
  socket: ConnectionLevel;
  upstream: ConnectionLevel;
  browserOnline: boolean;
  /** Composer readonly: a detected mismatch or lost connectivity. */
  isReadonly: boolean;
  /** F294 forwarding admission: also closed while the deployment is unverified. */
  forwardingBlocked: boolean;
  updateRequired: boolean;
  checkedAt: number | null;
}

export {
  createDeploymentRevisionTracker,
  type DeploymentRevisionState,
  reduceDeploymentRevision,
} from '@/utils/deployment-revision';

export interface DeploymentAdmission {
  /** Composer and other non-forwarding writes. */
  composerReadonly: boolean;
  /** Every F294 forwarding affordance, its picker, and its submit sink. */
  forwardingBlocked: boolean;
}

/**
 * Split the deployment guard's blast radius by what each state actually proves.
 *
 * F294 guards forwarding payloads, so an unproven deployment closes forwarding.
 * Only a *detected* mismatch closes the composer as well, because only then is
 * the document provably older than the runtime and a reload provably recovers.
 */
export function deriveDeploymentAdmission(
  revision: DeploymentRevisionState,
  connectivityDown: boolean,
): DeploymentAdmission {
  return {
    composerReadonly: revision.updateRequired || connectivityDown,
    forwardingBlocked: !revision.verified || revision.updateRequired || connectivityDown,
  };
}

const POLL_INTERVAL_MS = 15_000;
const REQUEST_TIMEOUT_MS = 2_500;
const FAILURE_THRESHOLD = 2;
const LOOPBACK_HOSTNAMES = new Set(['localhost', '127.0.0.1', '[::1]']);

export function isLoopbackApiUrl(apiUrl: string): boolean {
  try {
    const hostname = new URL(apiUrl).hostname.toLowerCase();
    return LOOPBACK_HOSTNAMES.has(hostname);
  } catch {
    return false;
  }
}

export function shouldForceBrowserOffline(browserOnline: boolean, apiUrl: string): boolean {
  return !browserOnline && !isLoopbackApiUrl(apiUrl);
}

export function deriveSocketLevel(
  browserOnline: boolean,
  socketConnected: boolean | null | undefined,
  apiUrl: string,
): ConnectionLevel {
  if (shouldForceBrowserOffline(browserOnline, apiUrl)) return 'offline';
  if (socketConnected == null) return 'online';
  return socketConnected ? 'online' : 'degraded';
}

function readBrowserOnline(): boolean {
  return typeof navigator === 'undefined' || navigator.onLine !== false;
}

function subscribeBrowserOnline(onChange: () => void): () => void {
  window.addEventListener('online', onChange);
  window.addEventListener('offline', onChange);
  return () => {
    window.removeEventListener('online', onChange);
    window.removeEventListener('offline', onChange);
  };
}

// No browser observation exists on the server (Node also exposes navigator).
// Hydration reuses this snapshot, then subscribes to the real browser signal.
const readServerOnline = () => true;

interface PublicProbeResult {
  level: ConnectionLevel;
  deploymentRevision: string | null;
}

async function probePublicEndpoint(path: string): Promise<PublicProbeResult> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const res = await fetch(`${API_URL}${path}`, {
      cache: 'no-store',
      credentials: 'include',
      signal: controller.signal,
    });
    if (!res.ok) return { level: 'degraded', deploymentRevision: null };
    const payload = (await res.json().catch(() => null)) as { deploymentRevision?: unknown } | null;
    const deploymentRevision = typeof payload?.deploymentRevision === 'string' ? payload.deploymentRevision : null;
    return { level: 'online', deploymentRevision };
  } catch {
    return { level: 'offline', deploymentRevision: null };
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

export function useConnectionStatus(
  socketConnected?: boolean | null,
  needed: boolean | number = true,
): ConnectionProbeState {
  const probesEnabled = process.env.NODE_ENV !== 'test';
  const browserOnline = useSyncExternalStore(subscribeBrowserOnline, readBrowserOnline, readServerOnline);
  const initialLevel = shouldForceBrowserOffline(browserOnline, API_URL) ? 'offline' : 'online';
  const [api, setApi] = useState<ConnectionLevel>(initialLevel);
  const [upstream, setUpstream] = useState<ConnectionLevel>(initialLevel);
  const [checkedAt, setCheckedAt] = useState<number | null>(null);
  // Health probes and every API response (api-client) report into the same page-lifetime tracker.
  const deploymentRevision = useSyncExternalStore(
    pageDeploymentRevision.subscribe,
    pageDeploymentRevision.read,
    pageDeploymentRevision.readInitial,
  );
  const mountedRef = useRef(true);
  const apiFailureCountRef = useRef(0);
  const upstreamFailureCountRef = useRef(0);
  const browserOfflineForcesDown = shouldForceBrowserOffline(browserOnline, API_URL);

  useEffect(() => {
    mountedRef.current = true;
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
    if (browserOfflineForcesDown) return;
    if (!probesEnabled || !needed || document.hidden) return;
    const [apiProbe, readyProbe, catsLevel] = await Promise.all([
      probePublicEndpoint('/api/health'),
      probePublicEndpoint('/api/ready'),
      probeCatsAvailability(),
    ]);
    if (!mountedRef.current) return;

    applyWithFailureThreshold(apiProbe.level, apiFailureCountRef, setApi);
    applyWithFailureThreshold(mergeUpstreamSignal(readyProbe.level, catsLevel), upstreamFailureCountRef, setUpstream);
    pageDeploymentRevision.observe(apiProbe.deploymentRevision, apiProbe.level === 'online');
    setCheckedAt(Date.now());
  }, [applyWithFailureThreshold, browserOfflineForcesDown, probesEnabled, needed]);

  useEffect(() => {
    if (browserOfflineForcesDown) {
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

    if (!needed) return;
    void runProbe();
    const visible = () => {
      if (!document.hidden) void runProbe();
    };
    document.addEventListener('visibilitychange', visible);
    const timer = setInterval(() => {
      void runProbe();
    }, POLL_INTERVAL_MS);
    return () => {
      clearInterval(timer);
      document.removeEventListener('visibilitychange', visible);
    };
  }, [browserOfflineForcesDown, runProbe, probesEnabled, needed]);

  useEffect(() => {
    if (socketConnected === true) void runProbe();
  }, [socketConnected, runProbe]);

  const socket = deriveSocketLevel(browserOnline, socketConnected, API_URL);

  const connectivityDown = browserOfflineForcesDown ? true : api === 'offline' && socket === 'offline';
  const admission = deriveDeploymentAdmission(deploymentRevision, connectivityDown);

  return {
    api,
    socket,
    upstream,
    browserOnline,
    isReadonly: admission.composerReadonly,
    forwardingBlocked: admission.forwardingBlocked,
    updateRequired: deploymentRevision.updateRequired,
    checkedAt,
  };
}
