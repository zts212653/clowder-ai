/**
 * Unified request identity resolver.
 *
 * Priority: X-Cat-Cafe-User header > userId query param > fallbackUserId > defaultUserId
 *
 * Header-based identity is preferred because:
 * - Not logged in access logs / referer headers / browser history
 * - Single injection point in frontend api-client
 * - Easier to upgrade to JWT/session later
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
 * Trusted request identity source for browser/API calls.
 *
 * Unlike resolveUserId(), this does not accept caller-controlled query params.
 */
export function resolveHeaderUserId(request: FastifyRequest): string | null {
  return nonEmptyString(request.headers['x-cat-cafe-user']);
}

export function resolveUserId(request: FastifyRequest, options?: ResolveUserIdOptions): string | null {
  const fromHeader = resolveHeaderUserId(request);
  if (fromHeader) return fromHeader;

  const query = request.query as Record<string, unknown>;
  const fromQuery = nonEmptyString(query.userId);
  if (fromQuery) return fromQuery;

  const fromFallback = nonEmptyString(options?.fallbackUserId);
  if (fromFallback) return fromFallback;

  return nonEmptyString(options?.defaultUserId);
}
