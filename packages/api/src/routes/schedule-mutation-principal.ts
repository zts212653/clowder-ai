import type { CatId } from '@cat-cafe/shared';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { requirePrivilegedRouteOwner } from '../utils/privileged-route-guard.js';
import { resolveSessionUserId } from '../utils/request-identity.js';

export type ScheduleMutationPrincipal =
  | {
      kind: 'cvo';
      userId: string;
    }
  | {
      kind: 'cat';
      authKind: 'invocation';
      invocationId: string;
      parentInvocationId?: string;
      threadId: string;
      userId: string;
      catId: CatId;
    }
  | {
      kind: 'cat';
      authKind: 'agent_key';
      agentKeyId: string;
      userId: string;
      catId: CatId;
    };

export type ScheduleMutationPrincipalFailure =
  | {
      ok: false;
      statusCode: 401;
      code: 'SCHEDULE_MUTATION_AUTH_REQUIRED';
      error: 'Authenticated owner session or verified cat principal required';
    }
  | {
      ok: false;
      statusCode: 403;
      code: 'SCHEDULE_MUTATION_OWNER_MISMATCH';
      error: 'Schedule mutation principal is not owned by the configured user';
    };

export type ScheduleMutationPrincipalResult =
  | { ok: true; principal: ScheduleMutationPrincipal }
  | ScheduleMutationPrincipalFailure;

const AUTH_REQUIRED: ScheduleMutationPrincipalFailure = {
  ok: false,
  statusCode: 401,
  code: 'SCHEDULE_MUTATION_AUTH_REQUIRED',
  error: 'Authenticated owner session or verified cat principal required',
};

const OWNER_MISMATCH: ScheduleMutationPrincipalFailure = {
  ok: false,
  statusCode: 403,
  code: 'SCHEDULE_MUTATION_OWNER_MISMATCH',
  error: 'Schedule mutation principal is not owned by the configured user',
};

/**
 * Runtime authorization boundary for F139 mutations.
 *
 * A verified callback/agent-key always remains a cat proxy, even if the HTTP
 * request also carries an owner session. Only a real session with no cat
 * principal is the direct operator path. Headers and request bodies never elevate
 * identity here.
 */
export function resolveScheduleMutationPrincipal(
  request: FastifyRequest,
  ownerUserId: string,
): ScheduleMutationPrincipalResult {
  const callbackPrincipal = request.callbackPrincipal;
  if (callbackPrincipal) {
    if (callbackPrincipal.userId !== ownerUserId) return OWNER_MISMATCH;
    if (callbackPrincipal.kind === 'invocation') {
      return {
        ok: true,
        principal: {
          kind: 'cat',
          authKind: 'invocation',
          invocationId: callbackPrincipal.invocationId,
          ...(callbackPrincipal.parentInvocationId ? { parentInvocationId: callbackPrincipal.parentInvocationId } : {}),
          threadId: callbackPrincipal.threadId,
          userId: callbackPrincipal.userId,
          catId: callbackPrincipal.catId,
        },
      };
    }
    return {
      ok: true,
      principal: {
        kind: 'cat',
        authKind: 'agent_key',
        agentKeyId: callbackPrincipal.agentKeyId,
        userId: callbackPrincipal.userId,
        catId: callbackPrincipal.catId,
      },
    };
  }

  const sessionUserId = resolveSessionUserId(request);
  if (!sessionUserId) return AUTH_REQUIRED;
  if (sessionUserId !== ownerUserId) return OWNER_MISMATCH;
  return { ok: true, principal: { kind: 'cvo', userId: sessionUserId } };
}

export function requireScheduleMutationPrincipal(
  request: FastifyRequest,
  reply: FastifyReply,
  ownerUserId: string,
): ScheduleMutationPrincipal | null {
  const result = resolveScheduleMutationPrincipal(request, ownerUserId);
  if (!result.ok) {
    reply.status(result.statusCode).send({ error: result.error, code: result.code });
    return null;
  }
  if (result.principal.kind === 'cvo') {
    const ownerGate = requirePrivilegedRouteOwner(request, reply, {
      surface: 'Direct schedule mutations',
      ownerErrorMessage: 'Direct schedule mutations can only be performed by the configured owner',
    });
    if (!ownerGate.ok) {
      reply.send(ownerGate.response);
      return null;
    }
  }
  return result.principal;
}
