import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import {
  PILOT_SKILL_ID,
  type SkillConsumptionReceiptService,
  type SkillConsumptionScope,
  type SkillConsumptionVerificationFailure,
} from '../domains/cats/services/tool-usage/SkillConsumptionReceiptService.js';
import { requireCallbackAuth } from './callback-auth-prehandler.js';

const prepareBodySchema = z.object({ skillId: z.literal(PILOT_SKILL_ID) }).strict();
const dismissBodySchema = z
  .object({
    handle: z.string().trim().min(1).max(2_000),
    reason: z.enum(['alternate_native_shortcut', 'outside_skill_scope']),
  })
  .strict();

export interface CallbackSkillConsumptionDeps {
  receipts: SkillConsumptionReceiptService;
}

function rejectUnsupportedPrincipal(request: FastifyRequest, reply: FastifyReply): boolean {
  if (request.callbackPrincipal?.kind !== 'agent_key') return false;
  reply.status(409).send({
    error: 'carrier_unsupported',
    reason: 'same_invocation_receipt_requires_invocation_auth',
  });
  return true;
}

function scopeFromAuth(auth: {
  userId: string;
  threadId: string;
  invocationId: string;
  catId: string;
}): SkillConsumptionScope {
  return {
    userId: auth.userId,
    threadId: auth.threadId,
    invocationId: auth.invocationId,
    catId: auth.catId,
  };
}

function replyVerificationFailure(reply: FastifyReply, reason: SkillConsumptionVerificationFailure): void {
  if (reason === 'expired') {
    reply.status(410).send({ error: reason });
    return;
  }
  if (reason === 'source_revision_changed' || reason === 'already_consumed') {
    reply.status(409).send({ error: reason });
    return;
  }
  reply.status(404).send({ error: 'not_available' });
}

export function registerCallbackSkillConsumptionRoutes(app: FastifyInstance, deps: CallbackSkillConsumptionDeps): void {
  app.post('/api/callbacks/skill-consumption/prepare', async (request, reply) => {
    if (rejectUnsupportedPrincipal(request, reply)) return;
    const auth = requireCallbackAuth(request, reply);
    if (!auth) return;
    const parsed = prepareBodySchema.safeParse(request.body);
    if (!parsed.success) {
      reply.status(400).send({ error: 'invalid_request', details: parsed.error.issues });
      return;
    }
    const prepared = await deps.receipts.prepare(parsed.data.skillId, scopeFromAuth(auth));
    if (!prepared.ok) {
      reply.status(404).send({ error: prepared.reason });
      return;
    }
    return prepared.preparation;
  });

  app.post('/api/callbacks/skill-consumption/dismiss', async (request, reply) => {
    if (rejectUnsupportedPrincipal(request, reply)) return;
    const auth = requireCallbackAuth(request, reply);
    if (!auth) return;
    const parsed = dismissBodySchema.safeParse(request.body);
    if (!parsed.success) {
      reply.status(400).send({ error: 'invalid_request', details: parsed.error.issues });
      return;
    }
    const recorded = await deps.receipts.recordDismissed({
      handle: parsed.data.handle,
      scope: scopeFromAuth(auth),
      reason: parsed.data.reason,
    });
    if (!recorded.ok) {
      replyVerificationFailure(reply, recorded.reason);
      return;
    }
    return { status: 'recorded', receipt: recorded.receipt };
  });
}
