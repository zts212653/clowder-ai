import type { FastifyReply, FastifyRequest } from 'fastify';
import { isDirectLoopbackRequest } from './loopback-request.js';
import { resolveOwnerGate } from './owner-gate.js';

export type PrivilegedRouteGuardResult = { ok: true; userId: string } | { ok: false; response: { error: string } };

export interface PrivilegedRouteGuardOptions {
  surface: string;
  ownerErrorMessage?: string;
}

function resolveSessionUserId(request: FastifyRequest): string | null {
  const userId = (request as FastifyRequest & { sessionUserId?: string }).sessionUserId;
  return typeof userId === 'string' && userId.trim() ? userId.trim() : null;
}

export function requirePrivilegedRouteOwner(
  request: FastifyRequest,
  reply: FastifyReply,
  options: PrivilegedRouteGuardOptions,
): PrivilegedRouteGuardResult {
  const userId = resolveSessionUserId(request);
  if (!userId) {
    reply.status(401);
    return { ok: false, response: { error: 'Authenticated session required (establish via GET /api/session)' } };
  }

  if (!isDirectLoopbackRequest(request) && !process.env.DEFAULT_OWNER_USER_ID?.trim()) {
    reply.status(403);
    return {
      ok: false,
      response: { error: `${options.surface} from non-localhost requires DEFAULT_OWNER_USER_ID to be configured` },
    };
  }

  const gateResult = resolveOwnerGate(userId, {
    errorMessage: options.ownerErrorMessage ?? `${options.surface} can only be accessed by the configured owner`,
  });
  if (gateResult) {
    reply.status(gateResult.status);
    return { ok: false, response: { error: gateResult.error } };
  }

  return { ok: true, userId };
}
