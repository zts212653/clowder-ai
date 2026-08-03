import {
  candidateInteractionDraftSchema,
  captureCandidateIdSchema,
  interactionEventIdSchema,
  materializableClaimPayloadSchema,
  personClaimIdSchema,
  personForgetRequestIdSchema,
  personIdSchema,
} from '@cat-cafe/shared';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import {
  type PersonMemoryDrillInput,
  PersonMemoryRecallService,
} from '../domains/memory/people/PersonMemoryRecallService.js';
import type { PersonMemoryStore } from '../domains/memory/people/PersonMemoryStore.js';
import { projectPersonMemoryProposalStatus } from '../domains/memory/people/person-memory-proposal-status.js';
import {
  observePersonMemoryStage,
  type PersonMemoryTelemetryOutcome,
} from '../domains/memory/people/person-memory-telemetry.js';
import type { WorkspacePersonResolver } from '../domains/memory/people/WorkspacePersonResolver.js';
import { requireCallbackAuth, requireCallbackPrincipal } from './callback-auth-prehandler.js';

const recallSchema = z.object({ alias: z.string().trim().min(1).max(160) }).strict();
const proposalStatusParamsSchema = z.object({ proposalId: captureCandidateIdSchema }).strict();
const drillSchema = z
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
const correctSchema = z
  .object({
    ...mutationBase,
    expectedCurrentClaimId: personClaimIdSchema,
    payload: materializableClaimPayloadSchema,
  })
  .strict();
const retireSchema = z
  .object({
    ...mutationBase,
    expectedCurrentClaimId: personClaimIdSchema,
  })
  .strict();
const amendSchema = z
  .object({
    ...mutationBase,
    expectedEventId: interactionEventIdSchema,
    payload: candidateInteractionDraftSchema.shape.payload,
  })
  .strict();
const forgetSchema = z
  .object({
    personId: personIdSchema,
    requestId: personForgetRequestIdSchema,
  })
  .strict();
const forgetProposalSchema = z
  .object({
    proposalId: captureCandidateIdSchema,
    requestId: personForgetRequestIdSchema,
  })
  .strict();
const redactSchema = z
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

export interface CallbackPersonMemoryDeps {
  store: Pick<
    PersonMemoryStore,
    | 'getCandidateForOwner'
    | 'correctClaim'
    | 'retireClaim'
    | 'amendInteractionEvent'
    | 'redactItem'
    | 'hardForget'
    | 'hardForgetProposal'
  >;
  recallService?: PersonMemoryRecallService;
  workspacePersonResolver?: WorkspacePersonResolver;
}

function invalid(reply: FastifyReply, error: z.ZodError): void {
  reply.status(400).send({ error: 'invalid_request', details: error.issues });
}

function resultOutcome(result: { status?: string; outcome?: string }): PersonMemoryTelemetryOutcome {
  const outcome = result.outcome ?? result.status;
  if (outcome === 'applied' || outcome === 'resolved' || outcome === 'ok' || outcome === 'purged') return 'success';
  if (outcome === 'replayed' || outcome === 'already_absent') return 'replayed';
  if (outcome === 'not_available') return 'not_available';
  if (outcome === 'conflict' || outcome === 'person_bound') return 'conflict';
  if (outcome === 'ambiguous') return 'ambiguous';
  if (outcome === 'budget_exceeded') return 'budget_exceeded';
  return 'error';
}

function requireWorkspacePersonResolver(deps: CallbackPersonMemoryDeps): WorkspacePersonResolver {
  if (!deps.workspacePersonResolver) {
    throw new Error('F276 recall requires a workspace person resolver');
  }
  return deps.workspacePersonResolver;
}

function exactSource(
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

export function registerCallbackPersonMemoryRoutes(app: FastifyInstance, deps: CallbackPersonMemoryDeps): void {
  const recallService =
    deps.recallService ??
    new PersonMemoryRecallService(deps.store as PersonMemoryStore, requireWorkspacePersonResolver(deps));

  app.get('/api/callbacks/person-memory/proposals/:proposalId/status', async (request, reply) => {
    const principal = requireCallbackPrincipal(request, reply);
    if (!principal) return;
    const params = proposalStatusParamsSchema.safeParse(request.params);
    if (!params.success) return invalid(reply, params.error);
    const candidate = await deps.store.getCandidateForOwner(principal.userId, params.data.proposalId);
    if (!candidate) {
      reply.status(404);
      return { error: 'not_available' };
    }
    return projectPersonMemoryProposalStatus(candidate);
  });

  app.post('/api/callbacks/person-memory/recall', async (request, reply) => {
    const principal = requireCallbackPrincipal(request, reply);
    if (!principal) return;
    const body = recallSchema.safeParse(request.body);
    if (!body.success) return invalid(reply, body.error);
    return observePersonMemoryStage(
      'recall',
      () => recallService.recallByAlias(principal.userId, body.data.alias),
      resultOutcome,
    );
  });

  app.post('/api/callbacks/person-memory/drill', async (request, reply) => {
    const principal = requireCallbackPrincipal(request, reply);
    if (!principal) return;
    const body = drillSchema.safeParse(request.body);
    if (!body.success) return invalid(reply, body.error);
    const input: PersonMemoryDrillInput = {
      ownerUserId: principal.userId,
      turnId: principal.kind === 'invocation' ? principal.invocationId : `agent-key:${principal.agentKeyId}`,
      personId: body.data.personId,
      item: body.data.item,
      timeWindow: body.data.timeWindow,
    };
    return observePersonMemoryStage('drill', () => recallService.drill(input), resultOutcome);
  });

  app.post('/api/callbacks/person-memory/correct-claim', async (request, reply) => {
    const body = correctSchema.safeParse(request.body);
    if (!body.success) return invalid(reply, body.error);
    const source = exactSource(request, reply, body.data.sourceMessageId);
    if (!source) return;
    return observePersonMemoryStage(
      'correct',
      () =>
        deps.store.correctClaim({
          ownerUserId: source.ownerUserId,
          personId: body.data.personId,
          expectedCurrentClaimId: body.data.expectedCurrentClaimId,
          payload: body.data.payload,
          sourceMessageRef: source.sourceMessageRef,
          requestId: body.data.requestId,
          correctedAt: Date.now(),
        }),
      resultOutcome,
    );
  });

  app.post('/api/callbacks/person-memory/retire-claim', async (request, reply) => {
    const body = retireSchema.safeParse(request.body);
    if (!body.success) return invalid(reply, body.error);
    const source = exactSource(request, reply, body.data.sourceMessageId);
    if (!source) return;
    return observePersonMemoryStage(
      'retire',
      () =>
        deps.store.retireClaim({
          ownerUserId: source.ownerUserId,
          personId: body.data.personId,
          expectedCurrentClaimId: body.data.expectedCurrentClaimId,
          sourceMessageRef: source.sourceMessageRef,
          requestId: body.data.requestId,
          retiredAt: Date.now(),
        }),
      resultOutcome,
    );
  });

  app.post('/api/callbacks/person-memory/amend-event', async (request, reply) => {
    const body = amendSchema.safeParse(request.body);
    if (!body.success) return invalid(reply, body.error);
    const source = exactSource(request, reply, body.data.sourceMessageId);
    if (!source) return;
    return observePersonMemoryStage(
      'amend',
      () =>
        deps.store.amendInteractionEvent({
          ownerUserId: source.ownerUserId,
          personId: body.data.personId,
          expectedEventId: body.data.expectedEventId,
          payload: body.data.payload,
          sourceMessageRef: source.sourceMessageRef,
          requestId: body.data.requestId,
          amendedAt: Date.now(),
        }),
      resultOutcome,
    );
  });

  app.post('/api/callbacks/person-memory/forget', async (request, reply) => {
    const auth = requireCallbackAuth(request, reply);
    if (!auth) return;
    const body = forgetSchema.safeParse(request.body);
    if (!body.success) return invalid(reply, body.error);
    const receipt = await observePersonMemoryStage('forget', () =>
      deps.store.hardForget({
        ownerUserId: auth.userId,
        personId: body.data.personId,
        requestId: body.data.requestId,
        requestedAt: Date.now(),
      }),
    );
    recallService.clearPerson(auth.userId, body.data.personId);
    return receipt;
  });

  app.post('/api/callbacks/person-memory/forget-proposal', async (request, reply) => {
    const auth = requireCallbackAuth(request, reply);
    if (!auth) return;
    const body = forgetProposalSchema.safeParse(request.body);
    if (!body.success) return invalid(reply, body.error);
    const result = await observePersonMemoryStage(
      'forget',
      () =>
        deps.store.hardForgetProposal({
          ownerUserId: auth.userId,
          proposalId: body.data.proposalId,
          requestId: body.data.requestId,
          requestedAt: Date.now(),
        }),
      resultOutcome,
    );
    if (result.outcome === 'person_bound') {
      return reply.status(409).send({ error: 'person_bound_use_forget_person' });
    }
    if (result.outcome === 'conflict') {
      return reply.status(409).send({ error: 'proposal_forget_conflict' });
    }
    if ('receipt' in result) return { result: result.receipt };
    return reply.status(409).send({ error: 'proposal_forget_conflict' });
  });

  app.post('/api/callbacks/person-memory/redact', async (request, reply) => {
    const auth = requireCallbackAuth(request, reply);
    if (!auth) return;
    const body = redactSchema.safeParse(request.body);
    if (!body.success) return invalid(reply, body.error);
    return observePersonMemoryStage(
      'redact',
      () =>
        deps.store.redactItem({
          ownerUserId: auth.userId,
          personId: body.data.personId,
          item: body.data.item,
          requestId: body.data.requestId,
          redactedAt: Date.now(),
        }),
      resultOutcome,
    );
  });
}
