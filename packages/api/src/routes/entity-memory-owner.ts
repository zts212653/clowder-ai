import { type EntityMemoryOwnerAction, entityMemoryOwnerActionSchema } from '@cat-cafe/shared';
import type { FastifyPluginAsync } from 'fastify';
import type { IEntityProposalStore } from '../domains/approval-hub/stores/ports/IEntityProposalStore.js';
import { entitySourceRevision, type StoredEntityRecord } from '../domains/memory/EntityRegistry.js';
import type { EntityMemoryLifecycleService } from '../domains/memory/entity/EntityMemoryLifecycleService.js';
import type { EntityMemoryLifecycleStore } from '../domains/memory/entity/EntityMemoryLifecycleStore.js';
import { resolveSessionUserId } from '../utils/request-identity.js';
import { readEntityMemoryProposals } from './entity-memory-proposals.js';
import { type EntityMemorySourceReaders, readEntityMemorySource } from './entity-memory-source.js';
import { authorizeOwnerBrowserAction, ownerMemoryActionHttpStatus } from './owner-memory-browser-auth.js';

export interface EntityMemoryOwnerRoutesOptions {
  ownerUserId: string;
  store: Pick<EntityMemoryLifecycleStore, 'get' | 'list'>;
  lifecycle?: Pick<EntityMemoryLifecycleService, 'executeOwnerAction'>;
  proposalStore: Pick<IEntityProposalStore, 'listByTarget'>;
  sourceReaders: EntityMemorySourceReaders;
}

export const entityMemoryOwnerRoutes: FastifyPluginAsync<EntityMemoryOwnerRoutesOptions> = async (app, opts) => {
  app.get('/api/memory/entities', async (request, reply) => {
    const owner = authorizeRead(request, reply, opts.ownerUserId);
    if (!owner) return;
    return { readStatus: 'ready', entries: opts.store.list().map(projectEntityEntry) };
  });

  app.get<{ Params: { entityId: string } }>('/api/memory/entities/:entityId', async (request, reply) => {
    const owner = authorizeRead(request, reply, opts.ownerUserId);
    if (!owner) return;
    const entity = opts.store.get(request.params.entityId);
    if (!entity) return reply.status(404).send({ error: 'Entity not found' });
    return {
      ...projectEntityEntry(entity),
      provenance: structuredClone(entity.provenance),
      proposals: await readEntityMemoryProposals(owner, entity.entityId, opts.proposalStore),
    };
  });

  app.get<{ Params: { entityId: string }; Querystring: { revision?: string } }>(
    '/api/memory/entities/:entityId/source',
    async (request, reply) => {
      const owner = authorizeRead(request, reply, opts.ownerUserId);
      if (!owner) return;
      if (!request.query.revision) return reply.status(400).send({ error: 'Revision required' });
      const entity = opts.store.get(request.params.entityId);
      if (!entity) return reply.status(404).send({ error: 'Entity not found' });
      if (entitySourceRevision(entity) !== request.query.revision) {
        return reply.status(409).send({ error: 'Revision changed' });
      }
      return readEntityMemorySource(entity, owner, opts.sourceReaders);
    },
  );

  app.post<{ Params: { entityId: string }; Body: EntityMemoryOwnerAction }>(
    '/api/memory/entities/:entityId/actions',
    async (request, reply) => {
      if (!authorizeOwnerBrowserAction(request)) return reply.status(403).send({ error: 'invalid_action' });
      const owner = resolveSessionUserId(request);
      if (!owner || owner !== opts.ownerUserId) return reply.status(403).send({ error: 'invalid_action' });
      if (!opts.lifecycle) return reply.status(503).send({ error: 'mutation_unavailable' });
      const body = entityMemoryOwnerActionSchema.safeParse(request.body);
      if (!body.success) return reply.status(400).send({ error: 'invalid_request', details: body.error.issues });
      try {
        const result = await opts.lifecycle.executeOwnerAction(owner, request.params.entityId, body.data);
        if (!('error' in result)) return result;
        return reply.status(ownerMemoryActionHttpStatus(result.error)).send(result);
      } catch (error) {
        request.log.warn({ err: error }, '[F321] Owner Entity mutation unavailable');
        return reply.status(503).send({ error: 'mutation_unavailable' });
      }
    },
  );
};

function authorizeRead(
  request: Parameters<typeof resolveSessionUserId>[0],
  reply: { status(code: number): { send(payload: unknown): unknown } },
  expectedOwner: string,
): string | null {
  const owner = resolveSessionUserId(request);
  if (!owner) {
    reply.status(401).send({ error: 'Session required' });
    return null;
  }
  if (owner !== expectedOwner) {
    reply.status(403).send({ error: 'Owner scope required' });
    return null;
  }
  return owner;
}

function projectEntityEntry(entity: StoredEntityRecord) {
  return {
    id: entity.entityId,
    type: 'entity' as const,
    revision: entitySourceRevision(entity),
    status: entity.status as 'active' | 'retired',
    entityType: entity.type,
    canonicalName: entity.canonicalName,
    aliases: [...entity.aliases],
    stance: entity.stance,
    visibilityScope: entity.visibilityScope,
    updatedAt: entity.updatedAt,
    provenanceCount: entity.provenance.length,
  };
}
