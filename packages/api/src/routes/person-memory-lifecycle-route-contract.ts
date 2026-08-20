import {
  candidateInteractionDraftSchema,
  captureCandidateIdSchema,
  interactionEventIdSchema,
  materializableClaimPayloadSchema,
  personClaimIdSchema,
  personForgetRequestIdSchema,
  personIdSchema,
} from '@cat-cafe/shared';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { PersonMemoryTelemetryOutcome } from '../domains/memory/people/person-memory-telemetry.js';
import { requireCallbackAuth } from './callback-auth-prehandler.js';

export const recallSchema = z.object({ alias: z.string().trim().min(1).max(160) }).strict();
export const proposalStatusParamsSchema = z.object({ proposalId: captureCandidateIdSchema }).strict();
export const drillSchema = z
  .object({
    personId: personIdSchema,
    item: z
      .object({
        kind: z.enum(['claim', 'relationship', 'event']),
        id: z.string().trim().min(1).max(200),
      })
      .strict(),
    timeWindow: z
      .object({
        from: z.number().int().nonnegative(),
        to: z.number().int().nonnegative(),
      })
      .strict(),
  })
  .strict();

const mutationBase = {
  personId: personIdSchema,
  sourceMessageId: z.string().trim().min(1).max(240).optional(),
  requestId: z.string().trim().min(1).max(200),
};

export const correctSchema = z
  .object({
    ...mutationBase,
    expectedCurrentClaimId: personClaimIdSchema,
    payload: materializableClaimPayloadSchema,
  })
  .strict();
export const retireSchema = z.object({ ...mutationBase, expectedCurrentClaimId: personClaimIdSchema }).strict();
export const amendSchema = z
  .object({
    ...mutationBase,
    expectedEventId: interactionEventIdSchema,
    payload: candidateInteractionDraftSchema.shape.payload,
  })
  .strict();
export const forgetSchema = z.object({ personId: personIdSchema, requestId: personForgetRequestIdSchema }).strict();
export const forgetProposalSchema = z
  .object({ proposalId: captureCandidateIdSchema, requestId: personForgetRequestIdSchema })
  .strict();
export const redactSchema = z
  .object({
    personId: personIdSchema,
    item: z
      .object({
        kind: z.enum(['claim', 'event']),
        id: z.string().trim().min(1).max(200),
      })
      .strict(),
    requestId: z.string().trim().min(1).max(200),
  })
  .strict();

export function invalid(reply: FastifyReply, error: z.ZodError): void {
  reply.status(400).send({ error: 'invalid_request', details: error.issues });
}

export function resultOutcome(result: { status?: string; outcome?: string }): PersonMemoryTelemetryOutcome {
  const outcome = result.outcome ?? result.status;
  if (outcome === 'applied' || outcome === 'resolved' || outcome === 'ok' || outcome === 'purged') return 'success';
  if (outcome === 'replayed' || outcome === 'already_absent') return 'replayed';
  if (outcome === 'not_available') return 'not_available';
  if (outcome === 'conflict' || outcome === 'person_bound') return 'conflict';
  if (outcome === 'ambiguous') return 'ambiguous';
  if (outcome === 'budget_exceeded') return 'budget_exceeded';
  return 'error';
}

export function exactSource(
  request: FastifyRequest,
  reply: FastifyReply,
  suppliedSourceMessageId: string | undefined,
): { ownerUserId: string; sourceMessageRef: { kind: 'message'; threadId: string; messageId: string } } | null {
  const auth = requireCallbackAuth(request, reply);
  if (!auth) return null;
  const sourceMessageId = auth.originTriggerMessageId ?? auth.a2aTriggerMessageId;
  if (!sourceMessageId) {
    reply.status(400).send({ error: 'exact_source_required' });
    return null;
  }
  if (suppliedSourceMessageId && suppliedSourceMessageId !== sourceMessageId) {
    reply.status(400).send({ error: 'sourceMessageId must match the authenticated invocation origin' });
    return null;
  }
  return {
    ownerUserId: auth.userId,
    sourceMessageRef: { kind: 'message', threadId: auth.threadId, messageId: sourceMessageId },
  };
}
