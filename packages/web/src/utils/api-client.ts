/**
 * Unified API client for Clowder AI frontend.
 *
 * - Resolves the API from desktop/runtime identity before build-time defaults
 * - Identity via HttpOnly session cookie (F156 D-1), not header self-reporting
 * - First call lazily establishes session, subsequent calls reuse the cookie
 */

import { useToastStore } from '../stores/toastStore';
import type { ApiFetchOptions, GetCoordinationState, GetGeneration } from './api-client-types';

export type { ApiFetchOptions } from './api-client-types';

import { markApiGetGeneration } from './api-get-generation';
import { resolveApiUrl } from './api-origin';
import { boundedFetch, waitForPromiseWithSignal } from './bounded-fetch';
import { tagSaveRequest, traceSaveTransport } from './member-save-trace';

export { resolveApiUrl } from './api-origin';

export const API_URL = resolveApiUrl();

const SESSION_BOOTSTRAP_TIMEOUT_MS = 10_000;
const API_REQUEST_TIMEOUT_MS = 30_000;

let sessionGate: Promise<void> | null = null;
let sessionRefresh: Promise<void> | null = null;
let sessionCsrfToken: string | null = null;
let lastSessionFailureToastAt = 0;

const reportedConnectionErrors = new WeakSet<object>();
let lastConnectionFailureAt = Number.NEGATIVE_INFINITY;

/** Shared transport feedback; a lost response does not prove a mutation failed. */
export function reportApiConnectionFailure(error: unknown): boolean {
  if (!(error instanceof Error) || (error.name !== 'TypeError' && error.name !== 'TimeoutError')) return false;
  if (reportedConnectionErrors.has(error)) return true;
  reportedConnectionErrors.add(error);
  const now = Date.now();
  if (now - lastConnectionFailureAt >= 5_000) {
    lastConnectionFailureAt = now;
    useToastStore.getState().addToast({
      type: 'error',
      title: '后端连接异常',
      message: '未能取得后端响应，请检查服务并刷新确认操作结果。',
      duration: 5000,
    });
  }
  return true;
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
    .then(async (res) => {
      if (!res.ok) {
        throw new Error(`session bootstrap failed (${res.status})`);
      }
      const body = (typeof res.json === 'function' ? await res.json().catch(() => null) : null) as {
        csrfToken?: unknown;
      } | null;
      sessionCsrfToken = typeof body?.csrfToken === 'string' && body.csrfToken ? body.csrfToken : null;
    })
    .catch((err) => {
      if (sessionGate === gate) {
        sessionGate = null;
        sessionCsrfToken = null;
      }
      throw err;
    });
  sessionGate = gate;
  return gate;
}

/** Revalidate the HttpOnly cookie before a new physical Socket handshake.
 * Parallel surfaces share one refresh; an older bootstrap finishes first so
 * its late Set-Cookie cannot overwrite the new server's session.
 */
export function refreshApiSession(): Promise<void> {
  if (sessionRefresh) return sessionRefresh;
  const previous = sessionGate;
  const gate = (previous ?? Promise.resolve())
    .catch(() => undefined)
    .then(async () => {
      const res = await boundedFetch(
        `${API_URL}/api/session`,
        { credentials: 'include' },
        SESSION_BOOTSTRAP_TIMEOUT_MS,
      );
      if (!res.ok) throw new Error(`session bootstrap failed (${res.status})`);
      const body = (typeof res.json === 'function' ? await res.json().catch(() => null) : null) as {
        csrfToken?: unknown;
      } | null;
      sessionCsrfToken = typeof body?.csrfToken === 'string' && body.csrfToken ? body.csrfToken : null;
    })
    .catch((err) => {
      if (sessionGate === gate) {
        sessionGate = null;
        sessionCsrfToken = null;
      }
      throw err;
    })
    .finally(() => {
      if (sessionRefresh === gate) sessionRefresh = null;
    });
  sessionGate = gate;
  sessionRefresh = gate;
  return gate;
}

function invalidateSession(observedGate: Promise<void>) {
  if (sessionGate === observedGate) {
    sessionGate = null;
    sessionCsrfToken = null;
  }
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

function withSessionCsrf(init?: RequestInit): RequestInit | undefined {
  const method = requestMethod(init);
  if (method === 'GET' || method === 'HEAD' || !sessionCsrfToken) return init;
  const headers = new Headers(init?.headers);
  headers.set('x-csrf-token', sessionCsrfToken);
  return { ...init, headers };
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

async function performApiFetch(path: string, init?: RequestInit, notifyFailure = true): Promise<Response> {
  try {
    return await performSessionRequest(path, init, notifyFailure);
  } catch (error) {
    if (notifyFailure && !init?.signal?.aborted) reportApiConnectionFailure(error);
    throw error;
  }
}

async function performSessionRequest(path: string, init?: RequestInit, notifyFailure = true): Promise<Response> {
  const initialSessionGate = ensureSession();
  await traceSaveTransport(init, 'session.wait', () => waitForPromiseWithSignal(initialSessionGate, init?.signal));
  const normalized = withSessionCsrf(ensureBodyForMutation(init));
  const res = await traceSaveTransport(
    init,
    'http.attempt',
    () =>
      boundedFetch(
        `${API_URL}${path}`,
        {
          ...normalized,
          credentials: 'include',
        },
        API_REQUEST_TIMEOUT_MS,
      ),
    1,
  );
  if (res.status !== 401) return res;

  // Session expired (API restart, cookie cleared). Re-establish and retry once.
  invalidateSession(initialSessionGate);
  const refreshedSessionGate = ensureSession();
  await traceSaveTransport(init, 'session.refresh', () => waitForPromiseWithSignal(refreshedSessionGate, init?.signal));
  const refreshed = withSessionCsrf(ensureBodyForMutation(init));
  const retryRes = await traceSaveTransport(
    init,
    'http.attempt',
    () =>
      boundedFetch(
        `${API_URL}${path}`,
        {
          ...refreshed,
          credentials: 'include',
        },
        API_REQUEST_TIMEOUT_MS,
      ),
    2,
  );
  if (retryRes.status === 401 && notifyFailure) notifySessionFailure();
  return retryRes;
}

function createGetGeneration(
  path: string,
  init: RequestInit | undefined,
  ifNoneMatch: string | null | undefined,
): GetGeneration {
  let resolve!: (response: Response) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<Response>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return {
    id: ++nextGetGeneration,
    promise,
    resolve,
    reject,
    path,
    init: withoutCallerSignal(init),
    ifNoneMatch,
  };
}

function physicalGetInit(generation: GetGeneration): RequestInit | undefined {
  const validator = generation.ifNoneMatch;
  if (!validator) return generation.init;
  const headers = new Headers(generation.init?.headers);
  headers.set('if-none-match', validator);
  return { ...generation.init, headers };
}

function startGetGeneration(key: string, state: GetCoordinationState, generation: GetGeneration): void {
  void performApiFetch(generation.path, physicalGetInit(generation))
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
  ifNoneMatch: string | null | undefined,
): Promise<Response> {
  const key = exactGetKey(path, init);
  let state = coordinatedGets.get(key);
  let generation: GetGeneration;

  if (!state) {
    generation = createGetGeneration(path, init, ifNoneMatch);
    state = { active: generation, trailing: null };
    coordinatedGets.set(key, state);
    startGetGeneration(key, state, generation);
  } else if (afterCurrentGet) {
    state.trailing ??= createGetGeneration(path, init, ifNoneMatch);
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
  init = tagSaveRequest(init);
  if (init?.signal?.aborted) {
    throw init.signal.reason ?? new DOMException('The operation was aborted.', 'AbortError');
  }
  if (requestMethod(init) === 'GET') {
    return coordinatedGet(path, init, options?.afterCurrentGet === true, options?.ifNoneMatch);
  }
  return performApiFetch(path, init);
}

/** Best-effort timing delivery recovers stale sessions without showing diagnostic-only failures to the user. */
export function sendMemberSaveDiagnostics(init: RequestInit): Promise<Response> {
  return performApiFetch('/api/diagnostics/member-save', init, false);
}
