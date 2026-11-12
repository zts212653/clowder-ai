import {
  candidateInteractionDraftSchema,
  interactionEventIdSchema,
  materializableClaimPayloadSchema,
  personClaimIdSchema,
  personForgetRequestIdSchema,
  personIdSchema,
} from '@cat-cafe/shared';
import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { OwnerMemoryActionService } from '../domains/memory/people/OwnerMemoryActionService.js';
import {
  type PersonMemoryOwnerReadDeps,
  PersonMemoryOwnerReadService,
} from '../domains/memory/people/PersonMemoryOwnerReadService.js';
import type { PersonMemoryStore } from '../domains/memory/people/PersonMemoryStore.js';
import { readMemoryUsage } from '../domains/memory/read-usage/MemoryReadUsageReader.js';
import { resolveSessionUserId } from '../utils/request-identity.js';
import { projectMemoryUsageThreads } from './memory-usage-threads.js';
import { authorizeOwnerBrowserAction, ownerMemoryActionHttpStatus } from './owner-memory-browser-auth.js';
import {
  type PersonMemoryOwnerDeferredDeps,
  registerPersonMemoryOwnerDeferredRoutes,
} from './person-memory-owner-deferred.js';
import { executeOwnerPersonRedaction } from './person-memory-owner-redaction.js';
import { registerPersonMemoryProposalForgetRoutes } from './person-memory-proposal-forget-routes.js';

const listQuerySchema = z
  .object({
    limit: z.coerce.number().int().min(1).max(50).optional(),
    offset: z.coerce.number().int().min(0).optional(),
  })
  .strict();
const personParamsSchema = z.object({ personId: personIdSchema }).strict();
const ownerActionRevisionSchema = z.string().regex(/^sha256:[a-f0-9]{64}$/);
const ownerActionRequestIdSchema = z
  .string()
  .trim()
  .min(32)
  .max(200)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/);
const ownerForgetRequestIdSchema = personForgetRequestIdSchema.refine((value) => value.length >= 32, {
  message: 'requestId must contain a high-entropy suffix',
});
const ownerActionBodySchema = z.discriminatedUnion('action', [
  z
    .object({
      action: z.literal('redact_item'),
      requestId: ownerActionRequestIdSchema,
      item: z.discriminatedUnion('kind', [
        z.object({ kind: z.literal('claim'), id: personClaimIdSchema }).strict(),
        z.object({ kind: z.literal('event'), id: interactionEventIdSchema }).strict(),
      ]),
      expectedRevision: ownerActionRevisionSchema,
      confirmed: z.literal(true),
    })
    .strict(),
  z
    .object({
      action: z.literal('correct_claim'),
      requestId: ownerActionRequestIdSchema,
      claimId: personClaimIdSchema,
      expectedRevision: ownerActionRevisionSchema,
      payload: materializableClaimPayloadSchema,
    })
    .strict(),
  z
    .object({
      action: z.literal('retire_claim'),
      requestId: ownerActionRequestIdSchema,
      claimId: personClaimIdSchema,
      expectedRevision: ownerActionRevisionSchema,
    })
    .strict(),
  z
    .object({
      action: z.literal('amend_event'),
      requestId: ownerActionRequestIdSchema,
      eventId: interactionEventIdSchema,
      expectedRevision: ownerActionRevisionSchema,
      payload: candidateInteractionDraftSchema.shape.payload,
    })
    .strict(),
  z
    .object({
      action: z.literal('hard_forget_person'),
      requestId: ownerForgetRequestIdSchema,
      expectedPersonRevision: ownerActionRevisionSchema,
      confirmed: z.literal(true),
    })
    .strict(),
]);
const sourceQuerySchema = z
  .object({
    kind: z.enum(['person', 'claim', 'relationship', 'event']),
    itemId: z.string().trim().min(1).max(200).optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.kind !== 'person' && !value.itemId) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['itemId'], message: 'itemId is required' });
    }
  });

export interface PersonMemoryOwnerReadRouteDeps
  extends Omit<PersonMemoryOwnerReadDeps, 'store'>,
    PersonMemoryOwnerDeferredDeps {
  readEvidenceDb?: import('better-sqlite3').Database;
  ownerUserId: string;
  store: PersonMemoryStore | null;
}

function unavailableList() {
  return { readStatus: 'unavailable' as const, entries: [], error: 'Person memory unavailable' };
}

export const personMemoryOwnerReadRoutes: FastifyPluginAsync<PersonMemoryOwnerReadRouteDeps> = async (app, deps) => {
  const service = deps.store
    ? new PersonMemoryOwnerReadService({
        store: deps.store,
        messageStore: deps.messageStore,
        threadStore: deps.threadStore,
        ...(deps.ownerPrivateArtifactResolver
          ? { ownerPrivateArtifactResolver: deps.ownerPrivateArtifactResolver }
          : {}),
      })
    : null;
  const mutationService = deps.store
    ? new OwnerMemoryActionService({
        store: deps.store,
        messageStore: deps.messageStore,
        threadStore: deps.threadStore,
        ...(deps.ownerPrivateArtifactResolver
          ? { ownerPrivateArtifactResolver: deps.ownerPrivateArtifactResolver }
          : {}),
      })
    : null;

  app.addHook('preHandler', async (request, reply) => {
    const sessionUserId = resolveSessionUserId(request);
    if (!sessionUserId) return reply.code(401).send({ error: 'Session required' });
    if (sessionUserId !== deps.ownerUserId) return reply.code(403).send({ error: 'Owner required' });
  });

  registerPersonMemoryProposalForgetRoutes(app, deps);
  registerPersonMemoryOwnerDeferredRoutes(app, deps);

  app.get<{ Params: { personId: string }; Querystring: { revision?: string } }>(
    '/api/memory/people/:personId/usage',
    async (request, reply) => {
      const params = personParamsSchema.safeParse(request.params);
      if (!params.success) return reply.code(404).send({ error: 'not_available' });
      if (!request.query.revision || !ownerActionRevisionSchema.safeParse(request.query.revision).success)
        return reply.code(400).send({ error: 'Revision required' });
      if (!service || !deps.readEvidenceDb) return reply.code(503).send({ error: 'usage_unavailable' });
      try {
        const result = await service.readDetail(deps.ownerUserId, params.data.personId);
        if (result.status !== 'ready') return reply.code(404).send({ error: 'not_available' });
        if (result.detail.personRevision !== request.query.revision)
          return reply.code(409).send({ error: 'Revision changed' });
        return await projectMemoryUsageThreads(
          readMemoryUsage(deps.readEvidenceDb, {
            owner: deps.ownerUserId,
            family: 'person_entity',
            anchor: `person-memory:${params.data.personId}`,
            revision: result.detail.personRevision,
            cueRevision: result.detail.readRevision,
          }),
          deps.ownerUserId,
          deps.threadStore,
        );
      } catch (error) {
        request.log.warn({ err: error }, 'Person usage unavailable');
        return reply.code(503).send({ error: 'usage_unavailable' });
      }
    },
  );

  app.get('/api/memory/people', async (request, reply) => {
    if (!service) return reply.code(503).send(unavailableList());
    const query = listQuerySchema.safeParse(request.query);
    if (!query.success) return reply.code(400).send({ error: 'invalid_request', details: query.error.issues });
    try {
      return await service.list(deps.ownerUserId, {
        limit: query.data.limit ?? 20,
        offset: query.data.offset ?? 0,
      });
    } catch (error) {
      request.log.warn({ err: error }, '[F276] Owner people list unavailable');
      return reply.code(503).send(unavailableList());
    }
  });

  app.get('/api/memory/people/:personId', async (request, reply) => {
    if (!service) return reply.code(503).send({ error: 'Person memory unavailable' });
    const params = personParamsSchema.safeParse(request.params);
    if (!params.success) return reply.code(404).send({ error: 'not_available' });
    try {
      const query = z
        .object({ deliveryRevision: ownerActionRevisionSchema.optional() })
        .strict()
        .safeParse(request.query);
      if (!query.success) return reply.code(400).send({ error: 'invalid_request' });
      const result = await service.readDetail(deps.ownerUserId, params.data.personId, query.data.deliveryRevision);
      if (result.status === 'version_changed') return reply.code(409).send({ error: 'Revision changed' });
      if (result.status === 'not_available') return reply.code(404).send({ error: 'not_available' });
      return result.detail;
    } catch (error) {
      request.log.warn({ err: error }, '[F276] Owner person detail unavailable');
      return reply.code(503).send({ error: 'Person memory unavailable' });
    }
  });

  app.get('/api/memory/people/:personId/source', async (request, reply) => {
    if (!service) return reply.code(503).send({ status: 'unavailable', sources: [] });
    const params = personParamsSchema.safeParse(request.params);
    const query = sourceQuerySchema.safeParse(request.query);
    if (!params.success) return reply.code(404).send({ error: 'not_available' });
    if (!query.success) return reply.code(400).send({ error: 'invalid_request', details: query.error.issues });
    try {
      const result = await service.readSource(deps.ownerUserId, params.data.personId, query.data, (reason) =>
        request.log.info({ reason }, '[F276] Owner person source rejected'),
      );
      if (result.status === 'not_available') return reply.code(404).send({ error: 'not_available' });
      if (result.status === 'unavailable') return { status: 'unavailable', sources: [] };
      return result;
    } catch (error) {
      request.log.warn({ err: error }, '[F276] Owner person source unavailable');
      return reply.code(503).send({ status: 'unavailable', sources: [] });
    }
  });

  app.post('/api/memory/people/:personId/actions', async (request, reply) => {
    const browserAuth = authorizeOwnerBrowserAction(request);
    if (!browserAuth) {
      return reply.code(403).send({ error: 'invalid_action' });
    }
    if (!mutationService || !deps.store) return reply.code(503).send({ error: 'mutation_unavailable' });
    const params = personParamsSchema.safeParse(request.params);
    if (!params.success) return reply.code(404).send({ error: 'not_available' });
    const body = ownerActionBodySchema.safeParse(request.body);
    if (!body.success) return reply.code(400).send({ error: 'invalid_request', details: body.error.issues });
    const command = { ...body.data, personId: params.data.personId };
    try {
      const result =
        command.action === 'redact_item'
          ? await executeOwnerPersonRedaction({ ...deps, store: deps.store }, command, request.log)
          : await mutationService.execute(
              {
                ownerUserId: deps.ownerUserId,
                sessionBindingId: browserAuth.sessionBindingId,
                csrfToken: browserAuth.csrfToken,
              },
              command,
            );
      if (result.outcome === 'applied' || result.outcome === 'replayed') return result;
      return reply.code(ownerMemoryActionHttpStatus(result.outcome)).send({ error: result.outcome });
    } catch (error) {
      request.log.warn({ err: error }, '[F276] Owner person mutation unavailable');
      return reply.code(503).send({ error: 'mutation_unavailable' });
    }
  });
};
