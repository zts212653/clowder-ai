import { exactAssetVersionRefV1Schema, reviewSubjectRefSchema } from '@cat-cafe/shared';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { InvocationRecord } from '../domains/cats/services/agents/invocation/InvocationRegistry.js';
import {
  PILOT_SKILL_ID,
  type SkillConsumptionReceiptService,
  type SkillConsumptionScope,
  type SkillConsumptionVerificationFailure,
} from '../domains/cats/services/tool-usage/SkillConsumptionReceiptService.js';
import type {
  RequestReviewUseReceiptService,
  RequestReviewUseScope,
} from '../infrastructure/capability-evolution/adapters/request-review/request-review-use-receipt.js';
import { requireCallbackAuth } from './callback-auth-prehandler.js';

const prepareBodySchema = z.object({ skillId: z.literal(PILOT_SKILL_ID) }).strict();
const dismissBodySchema = z
  .object({
    handle: z.string().trim().min(1).max(2_000),
    reason: z.enum(['alternate_native_shortcut', 'outside_skill_scope']),
  })
  .strict();
const requestReviewPrepareSchema = z
  .object({
    assetVersionRef: exactAssetVersionRefV1Schema,
    reviewerCatId: z.string().trim().min(1).max(120),
    reviewSubjectRef: reviewSubjectRefSchema,
    reviewedHeadSha: z.string().regex(/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/u),
    acceptedSourceRef: z.string().trim().min(1).max(2_000),
    acceptedRevision: z.string().trim().min(1).max(2_000),
  })
  .strict();
const requestReviewHandleSchema = z.object({ handle: z.string().trim().min(1).max(2_000) }).strict();
const requestReviewRecordSchema = requestReviewHandleSchema
  .extend({ reviewMessageId: z.string().trim().min(1).max(240) })
  .strict();
const requestReviewDismissSchema = requestReviewHandleSchema
  .extend({ reason: z.enum(['outside_local_review_scope', 'request_not_reviewable', 'route_replaced']) })
  .strict();

export interface CallbackSkillConsumptionDeps {
  receipts: SkillConsumptionReceiptService;
  requestReviewReceipts?: RequestReviewUseReceiptService;
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

function requestReviewScopeFromAuth(
  auth: Pick<
    InvocationRecord,
    | 'userId'
    | 'threadId'
    | 'invocationId'
    | 'catId'
    | 'ownerAuthProvenance'
    | 'originTriggerMessageId'
    | 'a2aTriggerMessageId'
  >,
): RequestReviewUseScope {
  return {
    ...scopeFromAuth(auth),
    ownerAuthProvenance: auth.ownerAuthProvenance,
    originMessageId: auth.originTriggerMessageId ?? auth.a2aTriggerMessageId,
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

  app.post('/api/callbacks/request-review-consumption/prepare', async (request, reply) => {
    if (rejectUnsupportedPrincipal(request, reply)) return;
    const auth = requireCallbackAuth(request, reply);
    if (!auth) return;
    if (auth.ownerAuthProvenance !== 'strict' || !(auth.originTriggerMessageId ?? auth.a2aTriggerMessageId)) {
      reply.status(403).send({ error: 'author_origin_unverified' });
      return;
    }
    if (!deps.requestReviewReceipts) {
      reply.status(503).send({ error: 'request_review_consumption_unavailable' });
      return;
    }
    const parsed = requestReviewPrepareSchema.safeParse(request.body);
    if (!parsed.success) {
      reply.status(400).send({ error: 'invalid_request', details: parsed.error.issues });
      return;
    }
    const prepared = await deps.requestReviewReceipts.prepare({
      scope: requestReviewScopeFromAuth(auth),
      ...parsed.data,
    });
    if (!prepared.ok) {
      reply.status(409).send({ error: prepared.reason });
      return;
    }
    return { state: 'prepared', ...prepared.preparation };
  });

  app.post('/api/callbacks/request-review-consumption/bind', async (request, reply) => {
    if (rejectUnsupportedPrincipal(request, reply)) return;
    const auth = requireCallbackAuth(request, reply);
    if (!auth) return;
    if (!deps.requestReviewReceipts) {
      reply.status(503).send({ error: 'request_review_consumption_unavailable' });
      return;
    }
    const parsed = requestReviewHandleSchema.safeParse(request.body);
    if (!parsed.success) {
      reply.status(400).send({ error: 'invalid_request', details: parsed.error.issues });
      return;
    }
    const bound = await deps.requestReviewReceipts.bindCurrentReviewer({
      handle: parsed.data.handle,
      scope: requestReviewScopeFromAuth(auth),
    });
    if (!bound.ok) {
      reply.status(409).send({ error: bound.reason });
      return;
    }
    return { status: bound.outcome };
  });

  app.post('/api/callbacks/request-review-consumption/record', async (request, reply) => {
    if (rejectUnsupportedPrincipal(request, reply)) return;
    const auth = requireCallbackAuth(request, reply);
    if (!auth) return;
    if (!deps.requestReviewReceipts) {
      reply.status(503).send({ error: 'request_review_consumption_unavailable' });
      return;
    }
    const parsed = requestReviewRecordSchema.safeParse(request.body);
    if (!parsed.success) {
      reply.status(400).send({ error: 'invalid_request', details: parsed.error.issues });
      return;
    }
    const recorded = await deps.requestReviewReceipts.recordLocalReview({
      ...parsed.data,
      scope: requestReviewScopeFromAuth(auth),
    });
    if (!recorded.ok) {
      reply.status(409).send({ error: recorded.reason });
      return;
    }
    return { status: recorded.outcome, receipt: recorded.receipt };
  });

  app.post('/api/callbacks/request-review-consumption/dismiss', async (request, reply) => {
    if (rejectUnsupportedPrincipal(request, reply)) return;
    const auth = requireCallbackAuth(request, reply);
    if (!auth) return;
    if (!deps.requestReviewReceipts) {
      reply.status(503).send({ error: 'request_review_consumption_unavailable' });
      return;
    }
    const parsed = requestReviewDismissSchema.safeParse(request.body);
    if (!parsed.success) {
      reply.status(400).send({ error: 'invalid_request', details: parsed.error.issues });
      return;
    }
    const recorded = await deps.requestReviewReceipts.dismiss({
      ...parsed.data,
      scope: requestReviewScopeFromAuth(auth),
    });
    if (!recorded.ok) {
      reply.status(409).send({ error: recorded.reason });
      return;
    }
    return { status: recorded.outcome, receipt: recorded.receipt };
  });
}
