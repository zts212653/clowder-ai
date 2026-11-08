import { matterWriteInputSchema } from '@cat-cafe/shared';
import type { FastifyInstance, FastifyPluginAsync, FastifyReply } from 'fastify';
import { z } from 'zod';
import type { MatterMemoryService } from '../domains/memory/matters/MatterMemoryService.js';
import { type MatterActor, MatterMemoryError } from '../domains/memory/matters/matter-source.js';
import { resolveSessionUserId } from '../utils/request-identity.js';
import { requireCallbackAuth } from './callback-auth-prehandler.js';
import { authorizeOwnerBrowserAction } from './owner-memory-browser-auth.js';

const catalogQuery = z
  .object({
    query: z.string().trim().max(200).optional(),
    cursor: z.string().max(2000).optional(),
    limit: z.coerce.number().int().min(1).max(30).optional(),
  })
  .strict();
const readQuery = catalogQuery.omit({ query: true }).extend({
  history: z
    .enum(['true', 'false'])
    .optional()
    .transform((value) => value === 'true'),
});
function failure(reply: FastifyReply, error: unknown) {
  if (error instanceof z.ZodError) return reply.status(400).send({ error: 'invalid_input', details: error.issues });
  if (error instanceof MatterMemoryError) {
    const status =
      error.code === 'not_available'
        ? 404
        : error.code === 'stale_revision' || error.code === 'request_conflict'
          ? 409
          : 400;
    const messages = {
      not_available: 'This page or source is not currently available to this reader.',
      invalid_source:
        'Select exact original text with raw UTF-16 start/end offsets (end exclusive) in body, quote_comment or quote_text; quote segments also require contentBlockIndex and attachmentId.',
      stale_revision: 'Read the current page and use its revision as expectedRevision before making a new change.',
      request_conflict:
        'This requestId already identifies a different change. Retry the original payload or use a new requestId.',
      invalid_cursor:
        'Restart from the directory or page; reuse nextCursor only with the same reader, query and page version.',
    };
    return reply.status(status).send({ error: error.code, message: messages[error.code] });
  }
  throw error;
}
interface MatterRouteOptions {
  service?: MatterMemoryService;
}

export function registerCallbackMatterMemoryRoutes(app: FastifyInstance, service?: MatterMemoryService) {
  app.get('/api/callbacks/memory-matters', async (request, reply) => {
    const record = requireCallbackAuth(request, reply);
    if (!record) return;
    if (!service) return reply.status(503).send({ error: 'matter_memory_unavailable' });
    try {
      return await service.catalog(
        { userId: record.userId, viewer: { type: 'cat', catId: record.catId } },
        { ...catalogQuery.parse(request.query), threadId: record.threadId },
      );
    } catch (error) {
      return failure(reply, error);
    }
  });
  app.get<{ Params: { matterId: string } }>('/api/callbacks/memory-matters/:matterId', async (request, reply) => {
    const record = requireCallbackAuth(request, reply);
    if (!record) return;
    if (!service) return reply.status(503).send({ error: 'matter_memory_unavailable' });
    try {
      return await service.readForInvocation(
        { ownerUserId: record.userId, threadId: record.threadId, invocationId: record.invocationId },
        record.catId,
        request.params.matterId,
        readQuery.parse(request.query),
      );
    } catch (error) {
      return failure(reply, error);
    }
  });
  app.post('/api/callbacks/memory-matters/write', async (request, reply) => {
    const record = requireCallbackAuth(request, reply);
    if (!record) return;
    if (!service) return reply.status(503).send({ error: 'matter_memory_unavailable' });
    try {
      const input = matterWriteInputSchema.parse(request.body);
      const result = await service.write(
        { userId: record.userId, viewer: { type: 'cat', catId: record.catId } },
        input,
      );
      reply.status(input.operation === 'create' && result.outcome === 'applied' ? 201 : 200);
      return result;
    } catch (error) {
      return failure(reply, error);
    }
  });
}

export const memoryMatterRoutes: FastifyPluginAsync<MatterRouteOptions> = async (app, { service }) => {
  const actor = (request: Parameters<typeof resolveSessionUserId>[0], reply: FastifyReply): MatterActor | null => {
    const userId = resolveSessionUserId(request);
    if (!userId) {
      reply.status(401).send({ error: 'Session required' });
      return null;
    }
    return { userId, viewer: { type: 'user' } };
  };
  app.post('/api/memory/matters/source', async (request, reply) => {
    const owner = actor(request, reply);
    if (!owner) return;
    if (!service) return reply.status(503).send({ error: 'matter_memory_unavailable' });
    try {
      const input = z
        .object({
          threadId: z.string().min(1).max(200),
          messageId: z.string().min(1).max(200),
          quote: z.string().min(1).max(8000),
        })
        .strict()
        .parse(request.body);
      return { source: await service.selectSource(owner, input) };
    } catch (error) {
      return failure(reply, error);
    }
  });
  app.get('/api/memory/matters', async (request, reply) => {
    const owner = actor(request, reply);
    if (!owner) return;
    if (!service) return reply.status(503).send({ error: 'matter_memory_unavailable' });
    try {
      return await service.catalog(owner, { ...catalogQuery.parse(request.query), management: true });
    } catch (error) {
      return failure(reply, error);
    }
  });
  app.get<{ Params: { matterId: string } }>('/api/memory/matters/:matterId', async (request, reply) => {
    const owner = actor(request, reply);
    if (!owner) return;
    if (!service) return reply.status(503).send({ error: 'matter_memory_unavailable' });
    try {
      return await service.read(owner, request.params.matterId, readQuery.parse(request.query));
    } catch (error) {
      return failure(reply, error);
    }
  });
  app.post('/api/memory/matters/write', async (request, reply) => {
    if (!authorizeOwnerBrowserAction(request)) return reply.status(403).send({ error: 'invalid_action' });
    const owner = actor(request, reply);
    if (!owner) return;
    if (!service) return reply.status(503).send({ error: 'matter_memory_unavailable' });
    try {
      return await service.write(owner, matterWriteInputSchema.parse(request.body));
    } catch (error) {
      return failure(reply, error);
    }
  });
};
