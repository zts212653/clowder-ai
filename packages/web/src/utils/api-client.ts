/**
 * Unified API client for Clowder AI frontend.
 *
 * - Auto-prepends NEXT_PUBLIC_API_URL
 * - Identity via HttpOnly session cookie (F156 D-1), not header self-reporting
 * - First call lazily establishes session, subsequent calls reuse the cookie
 */

import { useToastStore } from '../stores/toastStore';

function getBrowserLocation(): Location | null {
  if (typeof globalThis !== 'object' || globalThis === null) return null;
  const candidate = (globalThis as { location?: Location }).location;
  return candidate ?? null;
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
    // Build-time default (localhost) is wrong when accessed remotely — skip and auto-detect.
    const isLocalhostDefault = /^https?:\/\/(localhost|127\.0\.0\.1)[:/]/.test(envUrl);
    const isRemoteAccess = location != null && location.hostname !== 'localhost' && location.hostname !== '127.0.0.1';
    if (!isLocalhostDefault || !isRemoteAccess) return envUrl;
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

let sessionGate: Promise<void> | null = null;
let lastSessionFailureToastAt = 0;

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
  sessionGate = fetch(`${API_URL}/api/session`, { credentials: 'include' })
    .then((res) => {
      if (!res.ok) {
        throw new Error(`session bootstrap failed (${res.status})`);
      }
    })
    .catch((err) => {
      sessionGate = null;
      throw err;
    });
  return sessionGate;
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

/**
 * Fetch wrapper with session-cookie identity.
 *
 * On 401, re-establishes the session cookie and retries once.
 * This handles API restarts (in-memory session store cleared)
 * without requiring a manual page refresh.
 *
 * @param path - API path starting with '/' (e.g. '/api/messages')
 * @param init - Standard RequestInit options
 */
export async function apiFetch(path: string, init?: RequestInit): Promise<Response> {
  await ensureSession();
  const normalized = ensureBodyForMutation(init);
  const res = await fetch(`${API_URL}${path}`, {
    ...normalized,
    credentials: 'include',
  });
  if (res.status === 401) {
    // Session expired (API restart, cookie cleared). Re-establish and retry once.
    sessionGate = null;
    await ensureSession();
    const retryRes = await fetch(`${API_URL}${path}`, {
      ...normalized,
      credentials: 'include',
    });
    if (retryRes.status === 401) {
      notifySessionFailure();
    }
    return retryRes;
  }
  return res;
}
