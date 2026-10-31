import { exactAssetVersionRefV1Schema, ownerTruthRefV1Schema } from '@cat-cafe/shared';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { InvocationRecord } from '../domains/cats/services/agents/invocation/InvocationRegistry.js';
import type { RequestReviewOwnerFactAuthority } from '../infrastructure/capability-evolution/change/request-review-owner-fact-authority.js';
import type { RequestReviewOwnerReceiptService } from '../infrastructure/capability-evolution/change/request-review-owner-receipts.js';
import type { EvalRepairOutcomeService } from '../infrastructure/harness-eval/eval-repair-outcome.js';
import { requireCallbackAuth } from './callback-auth-prehandler.js';

const changed = z
  .object({
    type: z.literal('changed'),
    proposalId: z.string().trim().min(1).max(240),
    assetVersionRef: exactAssetVersionRefV1Schema,
    mainCommitSha: z.string().regex(/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/u),
    loadedRuntimeRef: ownerTruthRefV1Schema,
    changedAt: z.string().datetime({ offset: true }),
    loadedAt: z.string().datetime({ offset: true }),
  })
  .strict();
const noChange = z
  .object({
    type: z.literal('no_change'),
    proposalId: z.string().trim().min(1).max(240),
    reasonCode: z.enum([
      'evidence_already_satisfied',
      'risk_exceeds_benefit',
      'target_retired',
      'blocked_external',
      'other',
    ]),
    withdrawalCondition: z.string().trim().min(1).max(4_000),
    nextEvalAt: z.string().datetime({ offset: true }),
    recordedAt: z.string().datetime({ offset: true }),
  })
  .strict();
const evidence = z
  .object({
    type: z.literal('evidence'),
    proposalId: z.string().trim().min(1).max(240),
    assetVersionRef: exactAssetVersionRefV1Schema,
    role: z.enum(['comparison_baseline', 'candidate_independent_verification', 'post_adoption_observation']),
    evidenceRef: ownerTruthRefV1Schema,
    proofRef: ownerTruthRefV1Schema,
    status: z.enum(['verified', 'insufficient']),
    label: z.string().trim().min(1).max(400).optional(),
  })
  .strict();
const freshOutcome = z
  .object({
    type: z.literal('fresh_outcome'),
    proposalId: z.string().trim().min(1).max(240),
    interventionReceiptRef: ownerTruthRefV1Schema,
    reevaluationRef: ownerTruthRefV1Schema,
    freshnessProofRef: ownerTruthRefV1Schema,
    outcome: z.enum([
      'effective_keep',
      'ineffective_tune',
      'ineffective_rollback',
      'rubric_reopen',
      'insufficient_observe',
    ]),
    loadedRuntimeRef: ownerTruthRefV1Schema.optional(),
    measuredAt: z.string().datetime({ offset: true }),
    uncontaminated: z.boolean(),
  })
  .strict();
const rollback = z
  .object({
    type: z.literal('rollback'),
    proposalId: z.string().trim().min(1).max(240),
    interventionReceiptRef: ownerTruthRefV1Schema,
    restoredVersionRef: exactAssetVersionRefV1Schema,
    mainCommitSha: z.string().regex(/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/u),
    loadedRuntimeRef: ownerTruthRefV1Schema,
    restoredAt: z.string().datetime({ offset: true }),
    loadedAt: z.string().datetime({ offset: true }),
  })
  .strict();
const bodySchema = z.discriminatedUnion('type', [changed, noChange, evidence, freshOutcome, rollback]);

export type RequestReviewOwnerFactInput = z.infer<typeof bodySchema>;

export interface CallbackRequestReviewOwnerDeps {
  ownerUserId: string;
  receipts: RequestReviewOwnerReceiptService;
  factAuthority: Pick<RequestReviewOwnerFactAuthority, 'authorize'>;
  resolveOutcomeService(): Pick<EvalRepairOutcomeService, 'recordIntervention' | 'recordOutcome'> | undefined;
}

type OutcomeService = Pick<EvalRepairOutcomeService, 'recordIntervention' | 'recordOutcome'>;
type StatefulInterventionInput = Extract<RequestReviewOwnerFactInput, { type: 'changed' | 'no_change' }>;

function withoutTransportType<T extends RequestReviewOwnerFactInput>(input: T): Omit<T, 'type'> {
  const { type: _transportType, ...payload } = input;
  return payload;
}

function requireOwner(request: FastifyRequest, reply: FastifyReply, ownerUserId: string): InvocationRecord | undefined {
  const auth = requireCallbackAuth(request, reply);
  if (!auth) return undefined;
  if (
    auth.ownerAuthProvenance !== 'strict' ||
    auth.userId !== ownerUserId ||
    !(auth.originTriggerMessageId ?? auth.a2aTriggerMessageId)
  ) {
    reply.status(403).send({ status: 'blocked', reason: 'owner_origin_unverified' });
    return undefined;
  }
  return auth;
}

function sendBlocked(reply: FastifyReply, result: { status: 'blocked'; reason: string }) {
  reply.status(409).send(result);
}

function needsOutcomeConsumer(input: RequestReviewOwnerFactInput): boolean {
  return input.type === 'changed' || input.type === 'no_change' || input.type === 'fresh_outcome';
}

async function recordIntervention(
  input: StatefulInterventionInput,
  deps: CallbackRequestReviewOwnerDeps,
  outcomeService: OutcomeService,
) {
  const result =
    input.type === 'changed'
      ? await deps.receipts.recordChanged(withoutTransportType(input))
      : await deps.receipts.recordNoChange(withoutTransportType(input));
  if (result.status === 'blocked') return result;
  const receipt = await deps.receipts.resolveIntervention(result.receiptRef);
  if (!receipt) return { status: 'blocked' as const, reason: 'owner_receipt_not_found' };
  const lifecycle = await outcomeService.recordIntervention({ ...receipt, receiptRef: result.receiptRef });
  return lifecycle.status === 'blocked' ? lifecycle : { ...result, lifecycle };
}

async function recordFreshOutcome(
  input: Extract<RequestReviewOwnerFactInput, { type: 'fresh_outcome' }>,
  deps: CallbackRequestReviewOwnerDeps,
  outcomeService: OutcomeService,
) {
  const result = await deps.receipts.recordFreshOutcome(withoutTransportType(input));
  if (result.status === 'blocked') return result;
  const receipt = await deps.receipts.resolveFreshOutcome(result.receiptRef);
  if (!receipt) return { status: 'blocked' as const, reason: 'owner_receipt_not_found' };
  const lifecycle = await outcomeService.recordOutcome({
    caseRef: receipt.caseRef,
    proposalRef: receipt.proposalRef,
    approvalRef: receipt.approvalRef,
    ownerAuthorizationRef: receipt.ownerAuthorizationRef,
    targetVersionRef: receipt.targetVersionRef,
    interventionRef: receipt.interventionRef,
    interventionReceiptRef: receipt.interventionReceiptRef,
    outcomeReceiptRef: receipt.receiptRef,
  });
  return lifecycle.status === 'blocked' ? lifecycle : { ...result, lifecycle };
}

async function recordOwnerFact(
  input: RequestReviewOwnerFactInput,
  deps: CallbackRequestReviewOwnerDeps,
  outcomeService: OutcomeService | undefined,
) {
  if (input.type === 'evidence') return deps.receipts.linkEvidence(withoutTransportType(input));
  if (input.type === 'rollback') return deps.receipts.recordRollback(withoutTransportType(input));
  if (!outcomeService) throw new Error('request-review outcome consumer disappeared after preflight');
  return input.type === 'fresh_outcome'
    ? recordFreshOutcome(input, deps, outcomeService)
    : recordIntervention(input, deps, outcomeService);
}

export function registerCallbackRequestReviewOwnerRoutes(
  app: FastifyInstance,
  deps: CallbackRequestReviewOwnerDeps,
): void {
  app.post('/api/callbacks/request-review-owner/facts', async (request, reply) => {
    const principal = requireOwner(request, reply, deps.ownerUserId);
    if (!principal) return;
    const parsed = bodySchema.safeParse(request.body);
    if (!parsed.success) {
      reply.status(400).send({ error: 'invalid_request', details: parsed.error.issues });
      return;
    }
    const input = parsed.data;
    const needsOutcome = needsOutcomeConsumer(input);
    const outcomeService = needsOutcome ? deps.resolveOutcomeService() : undefined;
    if (needsOutcome && !outcomeService) {
      reply.status(503).send({ status: 'blocked', reason: 'outcome_route_unavailable' });
      return;
    }
    const authority = await deps.factAuthority.authorize({ proposalId: input.proposalId, principal });
    if (authority.status === 'blocked') {
      reply.status(403).send(authority);
      return;
    }
    const result = await recordOwnerFact(input, deps, outcomeService);
    return result.status === 'blocked' ? sendBlocked(reply, result) : result;
  });
}
