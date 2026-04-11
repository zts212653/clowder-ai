/**
 * Unified API client for Clowder AI frontend.
 *
 * - Auto-prepends NEXT_PUBLIC_API_URL
 * - Identity via HttpOnly session cookie (F156 D-1), not header self-reporting
 * - First call lazily establishes session, subsequent calls reuse the cookie
 */

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

function ensureSession(): Promise<void> {
  if (sessionGate) return sessionGate;
  sessionGate = fetch(`${API_URL}/api/session`, { credentials: 'include' })
    .then(() => {})
    .catch(() => {});
  return sessionGate;
}

/**
 * Fetch wrapper with session-cookie identity.
 * @param path - API path starting with '/' (e.g. '/api/messages')
 * @param init - Standard RequestInit options
 */
export async function apiFetch(path: string, init?: RequestInit): Promise<Response> {
  await ensureSession();
  return fetch(`${API_URL}${path}`, {
    ...init,
    credentials: 'include',
  });
}
