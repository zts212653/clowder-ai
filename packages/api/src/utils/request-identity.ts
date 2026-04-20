/**
 * Unified request identity resolver.
 *
 * Browser path (Origin header present): session cookie > defaultUserId.
 *   X-Cat-Cafe-User header and body fallback are blocked.
 * Non-browser path (no Origin): session cookie > X-Cat-Cafe-User header > body > defaultUserId.
 *
 * Blocking the header for browser requests prevents cross-origin identity
 * spoofing even when CORS_ALLOW_PRIVATE_NETWORK is enabled.
 */

import type { FastifyRequest } from 'fastify';
import { isOriginAllowed, PRIVATE_NETWORK_ORIGIN, resolveFrontendCorsOrigins } from '../config/frontend-origin.js';

export interface ResolveUserIdOptions {
  /** Optional explicit fallback (e.g., legacy body/form field). */
  fallbackUserId?: unknown;
  /** Optional final fallback (e.g., 'default-user' for backward compatibility). */
  defaultUserId?: string;
}

/**
 * Origins trusted for defaultUserId fallback (identity without session).
 * Excludes PRIVATE_NETWORK_ORIGIN — LAN devices must establish a session cookie.
 * Lazy-initialized on first call.
 */
let _trustedOrigins: (string | RegExp)[] | null = null;
function getTrustedOrigins(): (string | RegExp)[] {
  if (!_trustedOrigins) {
    _trustedOrigins = resolveFrontendCorsOrigins(process.env).filter((o) => o !== PRIVATE_NETWORK_ORIGIN);
  }
  return _trustedOrigins;
}

function nonEmptyString(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

export function resolveHeaderUserId(request: FastifyRequest): string | null {
  const fromSession = nonEmptyString((request as FastifyRequest & { sessionUserId?: string }).sessionUserId);
  if (fromSession) return fromSession;
  if (request.headers.origin) {
    // Trusted browser origins get default-user fallback when session is missing.
    // This prevents 28+ browser-facing routes from returning 401 on session loss
    // (API restart, cookie expiry) while still blocking untrusted origins.
    const origin = String(request.headers.origin);
    if (isOriginAllowed(origin, getTrustedOrigins())) {
      return 'default-user';
    }
    return null;
  }
  return nonEmptyString(request.headers['x-cat-cafe-user']);
}

export function resolveUserId(request: FastifyRequest, options?: ResolveUserIdOptions): string | null {
  // F156 D-1: session cookie is the primary identity source
  const fromSession = nonEmptyString((request as FastifyRequest & { sessionUserId?: string }).sessionUserId);
  if (fromSession) return fromSession;

  const fromHeader = resolveHeaderUserId(request);
  if (fromHeader) return fromHeader;

  // Browser requests: header was blocked above. Skip body fallback too
  // (prevents cross-origin POST body identity injection).
  // defaultUserId is only allowed for trusted origins (localhost/loopback/configured).
  // Private network origins (LAN/Tailscale) must use session cookies.
  if (request.headers.origin) {
    const origin = String(request.headers.origin);
    if (isOriginAllowed(origin, getTrustedOrigins())) {
      return nonEmptyString(options?.defaultUserId) ?? null;
    }
    return null;
  }

  const fromFallback = nonEmptyString(options?.fallbackUserId);
  if (fromFallback) return fromFallback;

  return nonEmptyString(options?.defaultUserId);
}
