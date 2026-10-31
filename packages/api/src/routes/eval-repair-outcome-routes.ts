import { exactAssetVersionRefV1Schema, ownerTruthRefV1Schema } from '@cat-cafe/shared';
import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { EvalRepairOutcomeService } from '../infrastructure/harness-eval/eval-repair-outcome.js';
import {
  type CallbackAuthRegistry,
  registerCallbackAuthHook,
  requireCallbackAuth,
} from './callback-auth-prehandler.js';

const boundRefsShape = {
  caseRef: ownerTruthRefV1Schema,
  proposalRef: ownerTruthRefV1Schema,
  approvalRef: ownerTruthRefV1Schema,
  ownerAuthorizationRef: ownerTruthRefV1Schema,
  targetVersionRef: exactAssetVersionRefV1Schema,
  interventionRef: ownerTruthRefV1Schema,
};

const interventionSchema = z.object({ ...boundRefsShape, receiptRef: ownerTruthRefV1Schema }).strict();
const outcomeSchema = z
  .object({
    ...boundRefsShape,
    interventionReceiptRef: ownerTruthRefV1Schema,
    outcomeReceiptRef: ownerTruthRefV1Schema,
  })
  .strict();

type OutcomePort = Pick<EvalRepairOutcomeService, 'recordIntervention' | 'recordOutcome'>;

export interface EvalRepairOutcomeRoutesOptions {
  callbackRegistry: CallbackAuthRegistry;
  ownerUserId: string;
  service?: OutcomePort;
}

function requireStrictOwnerOrigin(request: FastifyRequest, reply: FastifyReply, ownerUserId: string): boolean {
  const record = requireCallbackAuth(request, reply);
  if (!record) return false;
  const sourceMessageId = record.originTriggerMessageId ?? record.a2aTriggerMessageId;
  if (!sourceMessageId) {
    reply.status(409).send({ status: 'blocked', reason: 'origin_unbound' });
    return false;
  }
  if (record.ownerAuthProvenance !== 'strict' || record.userId !== ownerUserId) {
    reply.status(403).send({ status: 'blocked', reason: 'owner_origin_unverified' });
    return false;
  }
  return true;
}

export const evalRepairOutcomeRoutes: FastifyPluginAsync<EvalRepairOutcomeRoutesOptions> = async (app, options) => {
  registerCallbackAuthHook(app, options.callbackRegistry);

  app.post('/api/callbacks/eval-repair-interventions', async (request, reply) => {
    if (!requireStrictOwnerOrigin(request, reply, options.ownerUserId)) return;
    const parsed = interventionSchema.safeParse(request.body);
    if (!parsed.success) {
      reply.status(400);
      return { error: 'invalid_request', details: parsed.error.issues };
    }
    if (!options.service) {
      reply.status(503);
      return { status: 'blocked', reason: 'outcome_route_unavailable' };
    }
    const result = await options.service.recordIntervention(parsed.data);
    if (result.status === 'blocked') reply.status(409);
    return result;
  });

  app.post('/api/callbacks/eval-repair-outcomes', async (request, reply) => {
    if (!requireStrictOwnerOrigin(request, reply, options.ownerUserId)) return;
    const parsed = outcomeSchema.safeParse(request.body);
    if (!parsed.success) {
      reply.status(400);
      return { error: 'invalid_request', details: parsed.error.issues };
    }
    if (!options.service) {
      reply.status(503);
      return { status: 'blocked', reason: 'outcome_route_unavailable' };
    }
    const result = await options.service.recordOutcome(parsed.data);
    if (result.status === 'blocked') reply.status(409);
    return result;
  });
};
