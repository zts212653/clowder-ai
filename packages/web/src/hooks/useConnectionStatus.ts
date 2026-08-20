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
  /** Composer readonly: a detected mismatch or lost connectivity. */
  isReadonly: boolean;
  /** F294 forwarding admission: also closed while the deployment is unverified. */
  forwardingBlocked: boolean;
  updateRequired: boolean;
  checkedAt: number | null;
}

export interface DeploymentRevisionState {
  client: string | null;
  observed: string | null;
  verified: boolean;
  updateRequired: boolean;
}

const FULL_GIT_COMMIT = /^[0-9a-f]{40}$/;

function normalizeDeploymentRevision(value: string | undefined): string | null {
  const revision = value?.trim().toLowerCase();
  return revision && FULL_GIT_COMMIT.test(revision) ? revision : null;
}

const CLIENT_DEPLOYMENT_REVISION = normalizeDeploymentRevision(process.env.NEXT_PUBLIC_CAT_CAFE_BUILD_REVISION);
const DEPLOYMENT_REVISION_REQUIRED = process.env.NEXT_PUBLIC_CAT_CAFE_DEPLOYMENT_REVISION_REQUIRED === '1';

export function reduceDeploymentRevision(
  state: DeploymentRevisionState,
  observed: string | null,
  verificationRequired: boolean,
  responseSucceeded: boolean,
): DeploymentRevisionState {
  if (state.updateRequired || !responseSucceeded) return state;
  // Unknown is not unequal. Only two *known* revisions that differ are a
  // mismatch; anything else stays unverified, which closes forwarding without
  // latching a reload gate the page could never clear on its own.
  if (!observed) {
    return verificationRequired ? { ...state, verified: false } : state;
  }
  if (!state.client) {
    return verificationRequired ? { ...state, observed, verified: false } : { ...state, observed, verified: true };
  }
  if (state.client === observed) {
    return { ...state, observed, verified: true };
  }
  return { ...state, observed, verified: false, updateRequired: true };
}

export function createDeploymentRevisionTracker(
  client: string | null = CLIENT_DEPLOYMENT_REVISION,
  verificationRequired = DEPLOYMENT_REVISION_REQUIRED,
) {
  let state: DeploymentRevisionState = {
    client,
    observed: null,
    verified: !verificationRequired,
    updateRequired: false,
  };
  return {
    read: () => state,
    observe: (observed: string | null, responseSucceeded: boolean) => {
      state = reduceDeploymentRevision(state, observed, verificationRequired, responseSucceeded);
      return state;
    },
  };
}

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

// Module lifetime equals the current browser document. Client-side route changes
// may remount ChatContainer, but must not teach an old bundle a new baseline.
// A real page reload evaluates the module again and intentionally resets it.
const pageDeploymentRevision = createDeploymentRevisionTracker();

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

function getInitialBrowserOnline(): boolean {
  if (typeof navigator === 'undefined') return true;
  return navigator.onLine;
}

function getInitialConnectionLevel(): ConnectionLevel {
  return shouldForceBrowserOffline(getInitialBrowserOnline(), API_URL) ? 'offline' : 'online';
}

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

export function useConnectionStatus(socketConnected?: boolean | null): ConnectionProbeState {
  const probesEnabled = process.env.NODE_ENV !== 'test';
  const [browserOnline, setBrowserOnline] = useState<boolean>(getInitialBrowserOnline);
  const [api, setApi] = useState<ConnectionLevel>(getInitialConnectionLevel);
  const [upstream, setUpstream] = useState<ConnectionLevel>(getInitialConnectionLevel);
  const [checkedAt, setCheckedAt] = useState<number | null>(null);
  const [deploymentRevision, setDeploymentRevision] = useState<DeploymentRevisionState>(() =>
    pageDeploymentRevision.read(),
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
    if (!probesEnabled) return;
    const [apiProbe, readyProbe, catsLevel] = await Promise.all([
      probePublicEndpoint('/api/health'),
      probePublicEndpoint('/api/ready'),
      probeCatsAvailability(),
    ]);
    if (!mountedRef.current) return;

    applyWithFailureThreshold(apiProbe.level, apiFailureCountRef, setApi);
    applyWithFailureThreshold(mergeUpstreamSignal(readyProbe.level, catsLevel), upstreamFailureCountRef, setUpstream);
    setDeploymentRevision(pageDeploymentRevision.observe(apiProbe.deploymentRevision, apiProbe.level === 'online'));
    setCheckedAt(Date.now());
  }, [applyWithFailureThreshold, browserOfflineForcesDown, probesEnabled]);

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

    void runProbe();
    const timer = setInterval(() => {
      void runProbe();
    }, POLL_INTERVAL_MS);
    return () => clearInterval(timer);
  }, [browserOfflineForcesDown, runProbe, probesEnabled]);

  useEffect(() => {
    if (socketConnected === true) void runProbe();
  }, [socketConnected, runProbe]);

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
