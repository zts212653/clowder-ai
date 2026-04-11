/**
 * Unified request identity resolver.
 *
 * Priority (F156 D-1): session cookie > X-Cat-Cafe-User header > body fallback > defaultUserId
 *
 * The userId query param path is removed to prevent identity self-reporting via
 * URL. Session cookies are HttpOnly and server-issued, making them resistant to
 * CSWSH and XSS. Body fallback is retained for legacy compatibility (POST body
 * requires same-origin, unlike query params).
 */

import type { FastifyRequest } from 'fastify';

export interface ResolveUserIdOptions {
  /** Optional explicit fallback (e.g., legacy body/form field). */
  fallbackUserId?: unknown;
  /** Optional final fallback (e.g., 'default-user' for backward compatibility). */
  defaultUserId?: string;
}

function nonEmptyString(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/**
 * Trusted request identity source — session cookie first, header fallback.
 *
 * F156 D-1: session cookie (HttpOnly, server-issued) is the primary source.
 * Header is retained as opt-in for non-browser callers (scripts, MCP tools).
 */
export function resolveHeaderUserId(request: FastifyRequest): string | null {
  const fromSession = nonEmptyString((request as FastifyRequest & { sessionUserId?: string }).sessionUserId);
  if (fromSession) return fromSession;
  return nonEmptyString(request.headers['x-cat-cafe-user']);
}

export function resolveUserId(request: FastifyRequest, options?: ResolveUserIdOptions): string | null {
  // F156 D-1: session cookie is the primary identity source
  const fromSession = nonEmptyString((request as FastifyRequest & { sessionUserId?: string }).sessionUserId);
  if (fromSession) return fromSession;

  const fromHeader = resolveHeaderUserId(request);
  if (fromHeader) return fromHeader;

  // Legacy body field fallback (requires same-origin POST, not an attack vector)
  const fromFallback = nonEmptyString(options?.fallbackUserId);
  if (fromFallback) return fromFallback;

  return nonEmptyString(options?.defaultUserId);
}
