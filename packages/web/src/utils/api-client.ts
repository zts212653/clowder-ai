/**
 * Unified API client for Clowder AI frontend.
 *
 * - Auto-prepends NEXT_PUBLIC_API_URL
 * - Auto-injects X-Cat-Cafe-User identity header on every request
 * - Replaces scattered raw fetch() calls across hooks/components
 */

import { getUserId } from './userId';

function getBrowserLocation(): Location | null {
  if (typeof globalThis !== 'object' || globalThis === null) return null;
  const candidate = (globalThis as { location?: Location }).location;
  return candidate ?? null;
}

function resolveApiUrl(): string {
  const location = getBrowserLocation();

  // Cloudflare Tunnel: API 走 api.clowder-ai.com，Access cookie 在 .clowder-ai.com 上共享
  if (location?.hostname === 'cafe.clowder-ai.com') {
    return 'https://api.clowder-ai.com';
  }
  if (process.env.NEXT_PUBLIC_API_URL) return process.env.NEXT_PUBLIC_API_URL;
  if (typeof window === 'undefined') return 'http://localhost:3004';
  // Derive API port from frontend port: convention is frontend + 1 = API
  // (runtime: 3001→3002, alpha: 3011→3012). Fallback to +1 of current port.
  const frontendPort = Number(location?.port ?? '') || 3001;
  const apiPort = frontendPort + 1;
  const protocol = location?.protocol ?? 'http:';
  const hostname = location?.hostname ?? 'localhost';
  return `${protocol}//${hostname}:${apiPort}`;
}
export const API_URL = resolveApiUrl();

/**
 * Fetch wrapper that injects identity header.
 * @param path - API path starting with '/' (e.g. '/api/messages')
 * @param init - Standard RequestInit options
 */
export async function apiFetch(path: string, init?: RequestInit): Promise<Response> {
  const headers = new Headers(init?.headers);
  headers.set('X-Cat-Cafe-User', getUserId());
  return fetch(`${API_URL}${path}`, {
    ...init,
    headers,
    // Cloudflare Access: 跨子域名请求需要 credentials 才能带 CF_Authorization cookie
    credentials: API_URL.includes('clowder-ai.com') ? 'include' : (init?.credentials ?? 'same-origin'),
  });
}
