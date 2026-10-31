import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { EvalRepairApprovalService } from '../infrastructure/harness-eval/eval-repair-approval.js';
import type { EvalRepairDecisionReason } from '../infrastructure/harness-eval/eval-repair-approval-contracts.js';
import { resolveUserId } from '../utils/request-identity.js';
import {
  type CallbackAuthRegistry,
  registerCallbackAuthHook,
  requireCallbackAuth,
} from './callback-auth-prehandler.js';

const proposeSchema = z
  .object({
    caseActionRef: z.string().trim().min(1).max(500),
    clientMessageId: z.string().trim().min(1).max(240),
  })
  .strict();

const decisionSchema = z
  .object({
    reasonCode: z
      .enum(['accepted_as_proposed', 'wrong_target', 'insufficient_evidence', 'not_now', 'cost_too_high', 'other'])
      .optional(),
    reasonText: z.string().trim().min(1).max(500).optional(),
  })
  .strict()
  .optional();

type ServicePort = Pick<EvalRepairApprovalService, 'propose' | 'decide' | 'materialize'>;
type EvalRepairRouteDecision = 'approve' | 'reject' | 'withdraw';

export interface EvalRepairApprovalRoutesOptions {
  callbackRegistry: CallbackAuthRegistry;
  service?: ServicePort;
}

export const evalRepairApprovalRoutes: FastifyPluginAsync<EvalRepairApprovalRoutesOptions> = async (app, opts) => {
  registerCallbackAuthHook(app, opts.callbackRegistry);

  app.post('/api/callbacks/propose-eval-repair', async (request, reply) => {
    const record = requireCallbackAuth(request, reply);
    if (!record) return;
    const parsed = proposeSchema.safeParse(request.body);
    if (!parsed.success) {
      reply.status(400);
      return { error: 'invalid_request', details: parsed.error.issues };
    }
    if (!opts.service) {
      reply.status(503);
      return { status: 'blocked', reason: 'approval_route_unavailable' };
    }
    const originMessageId = record.originTriggerMessageId ?? record.a2aTriggerMessageId;
    if (!originMessageId) {
      reply.status(409);
      return { status: 'blocked', reason: 'origin_unbound' };
    }
    const result = await opts.service.propose({
      ...parsed.data,
      principal: {
        invocationId: record.invocationId,
        userId: record.userId,
        catId: record.catId,
        threadId: record.threadId,
        originMessageId,
      },
    });
    if (result.status === 'blocked') reply.status(409);
    return result;
  });

  for (const decision of ['approve', 'reject', 'withdraw'] as const) {
    app.post<{ Params: { proposalId: string } }>(
      `/api/eval-repair-proposals/:proposalId/${decision}`,
      createEvalRepairDecisionHandler(decision, opts.service),
    );
  }
};

function createEvalRepairDecisionHandler(decision: EvalRepairRouteDecision, service?: ServicePort) {
  return async (request: FastifyRequest<{ Params: { proposalId: string } }>, reply: FastifyReply) => {
    const userId = resolveUserId(request);
    if (!userId) {
      reply.status(401);
      return { error: 'Identity required' };
    }
    if (!service) {
      reply.status(503);
      return { status: 'blocked', reason: 'approval_route_unavailable' };
    }
    const parsed = decisionSchema.safeParse(request.body);
    if (!parsed.success) {
      reply.status(400);
      return { error: 'invalid_request', details: parsed.error.issues };
    }
    const canonicalDecision = canonicalDecisionFor(decision);
    const settled = await service.decide({
      proposalId: request.params.proposalId,
      decision: canonicalDecision,
      reasonCode: parsed.data?.reasonCode ?? defaultReasonFor(decision),
      ...(parsed.data?.reasonText ? { reasonText: parsed.data.reasonText } : {}),
      decidedByUserId: userId,
    });
    if (settled.status === 'blocked') {
      reply.status(409);
      return settled;
    }
    if (canonicalDecision !== 'accept' || !isAcceptedDecision(settled)) return settled;
    const materialization = await service.materialize(request.params.proposalId);
    return { ...settled, materialization };
  };
}

function canonicalDecisionFor(decision: EvalRepairRouteDecision): 'accept' | 'reject' | 'withdraw' {
  if (decision === 'approve') return 'accept';
  return decision;
}

function defaultReasonFor(decision: EvalRepairRouteDecision): EvalRepairDecisionReason {
  if (decision === 'approve') return 'accepted_as_proposed';
  if (decision === 'reject') return 'insufficient_evidence';
  return 'not_now';
}

function isAcceptedDecision(result: Awaited<ReturnType<ServicePort['decide']>>): boolean {
  return result.status === 'accepted' || (result.status === 'duplicate' && result.resolution === 'accepted');
}
