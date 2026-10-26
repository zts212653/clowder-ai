import { createHash, timingSafeEqual } from 'node:crypto';
import type { MemoryOwnerActionError } from '@cat-cafe/shared';
import type { FastifyRequest } from 'fastify';
import { isOriginAllowed, resolveFrontendCorsOrigins } from '../config/frontend-origin.js';

const FORBIDDEN_OWNER_ACTION_HEADERS = [
  'x-invocation-id',
  'x-callback-token',
  'x-agent-key-secret',
  'x-cat-cafe-user',
  'authorization',
] as const;

export interface OwnerBrowserActionContext {
  sessionBindingId: string;
  csrfToken: string;
}

export function authorizeOwnerBrowserAction(request: FastifyRequest): OwnerBrowserActionContext | null {
  if (request.callbackPrincipal) return null;
  if (FORBIDDEN_OWNER_ACTION_HEADERS.some((name) => request.headers[name] !== undefined)) return null;
  if (!request.sessionUserId || !request.sessionCsrfToken || !request.sessionBindingId) return null;
  const origin = requestHubOrigin(request);
  if (!origin || !isOriginAllowed(origin, resolveFrontendCorsOrigins(process.env))) return null;
  const presentedCsrf = request.headers['x-csrf-token'];
  if (typeof presentedCsrf !== 'string' || !equalSecret(presentedCsrf, request.sessionCsrfToken)) return null;
  return { sessionBindingId: request.sessionBindingId, csrfToken: request.sessionCsrfToken };
}

export function ownerMemoryActionHttpStatus(outcome: MemoryOwnerActionError | 'invalid_action'): number {
  if (outcome === 'invalid_content') return 400;
  if (outcome === 'not_available') return 404;
  if (
    outcome === 'stale_revision' ||
    outcome === 'source_unavailable' ||
    outcome === 'candidate_unavailable' ||
    outcome === 'conflict' ||
    outcome === 'idempotency_conflict'
  ) {
    return 409;
  }
  if (outcome === 'invalid_action') return 403;
  return 503;
}

function requestHubOrigin(request: FastifyRequest): string | null {
  const origin = request.headers.origin;
  if (typeof origin === 'string' && origin.trim()) return origin.trim();
  const referer = request.headers.referer;
  if (typeof referer !== 'string' || !referer.trim()) return null;
  try {
    return new URL(referer).origin;
  } catch {
    return null;
  }
}

function equalSecret(left: string, right: string): boolean {
  const leftDigest = createHash('sha256').update(left).digest();
  const rightDigest = createHash('sha256').update(right).digest();
  return timingSafeEqual(leftDigest, rightDigest);
}
