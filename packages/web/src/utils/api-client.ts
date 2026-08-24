/**
 * Unified API client for Clowder AI frontend.
 *
 * - Auto-prepends NEXT_PUBLIC_API_URL
 * - Identity via HttpOnly session cookie (F156 D-1), not header self-reporting
 * - First call lazily establishes session, subsequent calls reuse the cookie
 */

import { useToastStore } from '../stores/toastStore';
import { markApiGetGeneration } from './api-get-generation';
import { boundedFetch, waitForPromiseWithSignal } from './bounded-fetch';

function getBrowserLocation(): Location | null {
  if (typeof globalThis !== 'object' || globalThis === null) return null;
  const candidate = (globalThis as { location?: Location }).location;
  return candidate ?? null;
}

function isLoopbackLocation(location: Location | null): boolean {
  return location != null && (location.hostname === 'localhost' || location.hostname === '127.0.0.1');
}

/** @internal Exported for testing — prefer using `API_URL` constant. */
export function resolveApiUrl(): string {
  const location = getBrowserLocation();

  // Cloudflare Tunnel: API 走 api.clowder-ai.com，Access cookie 在 .clowder-ai.com 上共享
  if (location?.hostname === 'cafe.clowder-ai.com') {
    return 'https://api.clowder-ai.com';
  }
  const envUrl = process.env.NEXT_PUBLIC_API_URL;
  if (envUrl) {
    const isLocalhostDefault = /^https?:\/\/(localhost|127\.0\.0\.1)[:/]/.test(envUrl);
    const isLocalAccess = isLoopbackLocation(location);
    const isRemoteAccess = location != null && !isLocalAccess;
    // Skip envUrl when it mismatches actual access origin:
    //   - localhost env + remote browser → reverse-proxy users would hit dev's loopback
    //   - cloud env + local browser → would force a Cloudflare Tunnel round-trip for nothing
    const mismatch = (isLocalhostDefault && isRemoteAccess) || (!isLocalhostDefault && isLocalAccess);
    if (!mismatch) return envUrl;
  }
  if (typeof window === 'undefined') return 'http://localhost:3004';
  const protocol = location?.protocol ?? 'http:';
  const hostname = location?.hostname ?? 'localhost';
  const port = Number(location?.port ?? '') || 0;
  // Behind reverse proxy (default port 80/443 → port is empty string):
  // API lives at the same origin, proxied via /api/ and /socket.io/ paths.
  if (!port) return `${protocol}//${hostname}`;
  // Direct access with explicit port: convention frontendPort + 1 = apiPort
  // (runtime: 3001→3002, alpha: 3011→3012).
  return `${protocol}//${hostname}:${port + 1}`;
}
export const API_URL = resolveApiUrl();

const SESSION_BOOTSTRAP_TIMEOUT_MS = 10_000;
const API_REQUEST_TIMEOUT_MS = 30_000;

let sessionGate: Promise<void> | null = null;
let lastSessionFailureToastAt = 0;

export interface ApiFetchOptions {
  /**
   * A mutation happened while this exact GET may already be active. Attach the
   * caller to one bounded trailing generation instead of the possibly stale one.
   */
  afterCurrentGet?: boolean;
}

interface GetGeneration {
  id: number;
  promise: Promise<Response>;
  resolve(response: Response): void;
  reject(error: unknown): void;
  path: string;
  init: RequestInit | undefined;
}

interface GetCoordinationState {
  active: GetGeneration;
  trailing: GetGeneration | null;
}

const coordinatedGets = new Map<string, GetCoordinationState>();
let nextGetGeneration = 0;

function notifySessionFailure() {
  const now = Date.now();
  if (now - lastSessionFailureToastAt < 3000) return;
  lastSessionFailureToastAt = now;
  useToastStore.getState().addToast({
    type: 'error',
    title: '会话恢复失败',
    message: '登录态没有自动恢复成功。请稍后重试；如果仍无响应，再刷新页面。',
    duration: 6000,
  });
}

function ensureSession(): Promise<void> {
  if (sessionGate) return sessionGate;
  const gate = boundedFetch(`${API_URL}/api/session`, { credentials: 'include' }, SESSION_BOOTSTRAP_TIMEOUT_MS)
    .then((res) => {
      if (!res.ok) {
        throw new Error(`session bootstrap failed (${res.status})`);
      }
    })
    .catch((err) => {
      if (sessionGate === gate) sessionGate = null;
      throw err;
    });
  sessionGate = gate;
  return gate;
}

function invalidateSession(observedGate: Promise<void>) {
  if (sessionGate === observedGate) sessionGate = null;
}

/**
 * Ensure mutating requests (POST/PUT/PATCH/DELETE) carry a Content-Type
 * header and body. Bare POSTs with no body receive 415 Unsupported Media
 * Type through reverse proxies (Cloudflare Tunnel → Fastify).
 *
 * Callers that already set a body (including FormData) are left untouched.
 */
function ensureBodyForMutation(init?: RequestInit): RequestInit | undefined {
  if (!init?.method) return init;
  const method = init.method.toUpperCase();
  if (method === 'GET' || method === 'HEAD') return init;
  if (init.body != null) return init;
  return {
    ...init,
    headers: { 'content-type': 'application/json', ...(init.headers as Record<string, string>) },
    body: '{}',
  };
}

function requestMethod(init?: RequestInit): string {
  return (init?.method ?? 'GET').toUpperCase();
}

function exactGetKey(path: string, init?: RequestInit): string {
  const headers: [string, string][] = [];
  new Headers(init?.headers).forEach((value, name) => {
    headers.push([name, value]);
  });
  headers.sort(([leftName, leftValue], [rightName, rightValue]) =>
    leftName === rightName ? leftValue.localeCompare(rightValue) : leftName.localeCompare(rightName),
  );
  return JSON.stringify({
    url: `${API_URL}${path}`,
    headers,
    cache: init?.cache ?? null,
    mode: init?.mode ?? null,
    redirect: init?.redirect ?? null,
    referrer: init?.referrer ?? null,
    referrerPolicy: init?.referrerPolicy ?? null,
    integrity: init?.integrity ?? null,
    keepalive: init?.keepalive ?? null,
  });
}

function withoutCallerSignal(init?: RequestInit): RequestInit | undefined {
  if (!init) return undefined;
  const physicalInit = { ...init };
  delete physicalInit.signal;
  return physicalInit;
}

async function performApiFetch(path: string, init?: RequestInit): Promise<Response> {
  const initialSessionGate = ensureSession();
  await waitForPromiseWithSignal(initialSessionGate, init?.signal);
  const normalized = ensureBodyForMutation(init);
  const res = await boundedFetch(
    `${API_URL}${path}`,
    {
      ...normalized,
      credentials: 'include',
    },
    API_REQUEST_TIMEOUT_MS,
  );
  if (res.status !== 401) return res;

  // Session expired (API restart, cookie cleared). Re-establish and retry once.
  invalidateSession(initialSessionGate);
  const refreshedSessionGate = ensureSession();
  await waitForPromiseWithSignal(refreshedSessionGate, init?.signal);
  const retryRes = await boundedFetch(
    `${API_URL}${path}`,
    {
      ...normalized,
      credentials: 'include',
    },
    API_REQUEST_TIMEOUT_MS,
  );
  if (retryRes.status === 401) notifySessionFailure();
  return retryRes;
}

function createGetGeneration(path: string, init?: RequestInit): GetGeneration {
  let resolve!: (response: Response) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<Response>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { id: ++nextGetGeneration, promise, resolve, reject, path, init: withoutCallerSignal(init) };
}

function startGetGeneration(key: string, state: GetCoordinationState, generation: GetGeneration): void {
  void performApiFetch(generation.path, generation.init)
    .then(generation.resolve, generation.reject)
    .finally(() => {
      if (state.active !== generation) return;
      const trailing = state.trailing;
      if (!trailing) {
        coordinatedGets.delete(key);
        return;
      }
      state.active = trailing;
      state.trailing = null;
      startGetGeneration(key, state, trailing);
    });
}

async function coordinatedGet(
  path: string,
  init: RequestInit | undefined,
  afterCurrentGet: boolean,
): Promise<Response> {
  const key = exactGetKey(path, init);
  let state = coordinatedGets.get(key);
  let generation: GetGeneration;

  if (!state) {
    generation = createGetGeneration(path, init);
    state = { active: generation, trailing: null };
    coordinatedGets.set(key, state);
    startGetGeneration(key, state, generation);
  } else if (afterCurrentGet) {
    state.trailing ??= createGetGeneration(path, init);
    generation = state.trailing;
  } else {
    generation = state.active;
  }

  const response = await waitForPromiseWithSignal(generation.promise, init?.signal);
  const clone = response.clone();
  markApiGetGeneration(clone, generation.id);
  return clone;
}

/**
 * Fetch wrapper with session-cookie identity.
 *
 * On 401, re-establishes the session cookie and retries once.
 * This handles API restarts (in-memory session store cleared)
 * without requiring a manual page refresh.
 *
 * @param path - API path starting with '/' (e.g. '/api/messages')
 * @param init - Standard RequestInit options
 * @param options - GET generation coordination options
 */
export async function apiFetch(path: string, init?: RequestInit, options?: ApiFetchOptions): Promise<Response> {
  if (init?.signal?.aborted) {
    throw init.signal.reason ?? new DOMException('The operation was aborted.', 'AbortError');
  }
  if (requestMethod(init) === 'GET') {
    return coordinatedGet(path, init, options?.afterCurrentGet === true);
  }
  return performApiFetch(path, init);
}
