import type { FastifyInstance } from 'fastify';
import {
  type PersonMemoryDrillInput,
  PersonMemoryRecallService,
} from '../domains/memory/people/PersonMemoryRecallService.js';
import type { PersonMemoryStore } from '../domains/memory/people/PersonMemoryStore.js';
import { projectPersonMemoryProposalStatus } from '../domains/memory/people/person-memory-proposal-status.js';
import { observePersonMemoryStage } from '../domains/memory/people/person-memory-telemetry.js';
import type { WorkspacePersonResolver } from '../domains/memory/people/WorkspacePersonResolver.js';
import { requireCallbackAuth, requireCallbackPrincipal } from './callback-auth-prehandler.js';
import {
  amendSchema,
  correctSchema,
  drillSchema,
  exactSource,
  forgetProposalSchema,
  forgetSchema,
  invalid,
  proposalStatusParamsSchema,
  recallSchema,
  redactSchema,
  resultOutcome,
  retireSchema,
} from './person-memory-lifecycle-route-contract.js';
import {
  prepareCandidateWriteOpportunityInvalidation,
  preparePersonWriteOpportunityInvalidation,
} from './person-memory-write-opportunity-route-invalidation.js';

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
    | 'listCandidateIdsForPerson'
  >;
  recallService?: PersonMemoryRecallService;
  workspacePersonResolver?: WorkspacePersonResolver;
  writeOpportunityTerminalLedger?: import('../domains/memory/people/WriteOpportunityTerminalLedger.js').WriteOpportunityTerminalLedger;
  writeOpportunityDeliveryStore?: import('../domains/memory/people/WriteOpportunityDeliveryStore.js').WriteOpportunityDeliveryStore;
}

function requireWorkspacePersonResolver(deps: CallbackPersonMemoryDeps): WorkspacePersonResolver {
  if (!deps.workspacePersonResolver) {
    throw new Error('F276 recall requires a workspace person resolver');
  }
  return deps.workspacePersonResolver;
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
    const invalidate = await preparePersonWriteOpportunityInvalidation({
      deps,
      ownerUserId: source.ownerUserId,
      personId: body.data.personId,
      reason: 'source_corrected',
      log: request.log,
    });
    const result = await observePersonMemoryStage(
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
    if (!(await invalidate(result.outcome === 'applied' || result.outcome === 'replayed'))) {
      return reply.status(503).send({ error: 'write_opportunity_invalidation_pending' });
    }
    return result;
  });

  app.post('/api/callbacks/person-memory/retire-claim', async (request, reply) => {
    const body = retireSchema.safeParse(request.body);
    if (!body.success) return invalid(reply, body.error);
    const source = exactSource(request, reply, body.data.sourceMessageId);
    if (!source) return;
    const invalidate = await preparePersonWriteOpportunityInvalidation({
      deps,
      ownerUserId: source.ownerUserId,
      personId: body.data.personId,
      reason: 'source_forgotten',
      log: request.log,
    });
    const result = await observePersonMemoryStage(
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
    if (!(await invalidate(result.outcome === 'applied' || result.outcome === 'replayed'))) {
      return reply.status(503).send({ error: 'write_opportunity_invalidation_pending' });
    }
    return result;
  });

  app.post('/api/callbacks/person-memory/amend-event', async (request, reply) => {
    const body = amendSchema.safeParse(request.body);
    if (!body.success) return invalid(reply, body.error);
    const source = exactSource(request, reply, body.data.sourceMessageId);
    if (!source) return;
    const invalidate = await preparePersonWriteOpportunityInvalidation({
      deps,
      ownerUserId: source.ownerUserId,
      personId: body.data.personId,
      reason: 'source_corrected',
      log: request.log,
    });
    const result = await observePersonMemoryStage(
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
    if (!(await invalidate(result.outcome === 'applied' || result.outcome === 'replayed'))) {
      return reply.status(503).send({ error: 'write_opportunity_invalidation_pending' });
    }
    return result;
  });

  app.post('/api/callbacks/person-memory/forget', async (request, reply) => {
    const auth = requireCallbackAuth(request, reply);
    if (!auth) return;
    const body = forgetSchema.safeParse(request.body);
    if (!body.success) return invalid(reply, body.error);
    const invalidate = await preparePersonWriteOpportunityInvalidation({
      deps,
      ownerUserId: auth.userId,
      personId: body.data.personId,
      reason: 'source_forgotten',
      log: request.log,
    });
    if (!(await invalidate(true))) {
      return reply.status(503).send({ error: 'write_opportunity_invalidation_pending' });
    }
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
    const invalidate = await prepareCandidateWriteOpportunityInvalidation({
      deps,
      ownerUserId: auth.userId,
      candidateId: body.data.proposalId,
      reason: 'source_forgotten',
      log: request.log,
    });
    if (!(await invalidate(true))) {
      return reply.status(503).send({ error: 'write_opportunity_invalidation_pending' });
    }
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
    const invalidate = await preparePersonWriteOpportunityInvalidation({
      deps,
      ownerUserId: auth.userId,
      personId: body.data.personId,
      reason: 'source_forgotten',
      log: request.log,
    });
    const result = await observePersonMemoryStage(
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
    if (!(await invalidate(result.outcome === 'applied' || result.outcome === 'replayed'))) {
      return reply.status(503).send({ error: 'write_opportunity_invalidation_pending' });
    }
    return result;
  });
}
