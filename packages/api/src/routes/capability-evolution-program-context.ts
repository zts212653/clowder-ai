import type { CallbackPrincipal } from '@cat-cafe/shared';
import type { FastifyReply, FastifyRequest } from 'fastify';
import type {
  EvolutionChangeRequestAuthority,
  EvolutionValueDecisionAuthority,
} from '../infrastructure/capability-evolution/change/program-change-owner-contract.js';

/**
 * Who is asking, and on whose behalf.
 *
 * Every Program route derives the owner, the workspace and the actor from the authenticated
 * principal rather than from the request body — a caller that could name its own workspace could
 * read and drive somebody else's Program. Kept in one place so that rule has a single
 * implementation instead of one per handler.
 */

export interface ProgramRequestContext {
  ownerUserId: string;
  workspaceId: string;
  actorRef: string;
  originFor(clientMessageId: string): string;
  changeRequestAuthority?: EvolutionChangeRequestAuthority;
  valueDecisionAuthority?: EvolutionValueDecisionAuthority;
}

function sessionUserId(request: FastifyRequest): string | undefined {
  const value = (request as FastifyRequest & { sessionUserId?: string }).sessionUserId;
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;
}

function contextFromPrincipal(request: FastifyRequest, principal: CallbackPrincipal): ProgramRequestContext {
  if (principal.kind === 'invocation') {
    const record = request.callbackAuth;
    const originMessageId = record?.originTriggerMessageId ?? record?.a2aTriggerMessageId;
    const changeRequestAuthority =
      record?.invocationId === principal.invocationId && originMessageId
        ? {
            invocationId: record.invocationId,
            userId: record.userId,
            catId: record.catId,
            threadId: record.threadId,
            originMessageId,
          }
        : undefined;
    return {
      ownerUserId: principal.userId,
      workspaceId: `user:${principal.userId}`,
      actorRef: `cat:${principal.catId}`,
      originFor: (clientMessageId) =>
        `thread:${principal.threadId}:invocation:${principal.invocationId}:message:${clientMessageId}`,
      ...(changeRequestAuthority ? { changeRequestAuthority } : {}),
      ...(changeRequestAuthority
        ? { valueDecisionAuthority: { kind: 'owner_source' as const, ...changeRequestAuthority } }
        : {}),
    };
  }
  return {
    ownerUserId: principal.userId,
    workspaceId: `user:${principal.userId}`,
    actorRef: `cat:${principal.catId}`,
    originFor: (clientMessageId) => `agent-key:${principal.agentKeyId}:message:${clientMessageId}`,
  };
}

export function requireContext(request: FastifyRequest, reply: FastifyReply): ProgramRequestContext | undefined {
  if (request.callbackPrincipal) return contextFromPrincipal(request, request.callbackPrincipal);
  const userId = sessionUserId(request);
  if (!userId) {
    reply.status(401).send({ error: 'unauthorized' });
    return undefined;
  }
  return {
    ownerUserId: userId,
    workspaceId: `user:${userId}`,
    actorRef: `user:${userId}`,
    originFor: (clientMessageId) => `browser:${userId}:message:${clientMessageId}`,
    valueDecisionAuthority: { kind: 'owner_session', userId },
  };
}
