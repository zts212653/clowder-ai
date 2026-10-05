import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { companionDecisionWireResponse, readCompanionDecisionProjection } from './companion-decision-read-service.js';
import { requirePluginOwnerLocalAccess } from './plugin-access-guards.js';

const pageSchema = z
  .object({
    offset: z.coerce.number().int().min(0).default(0),
    limit: z.coerce.number().int().min(1).max(20).default(20),
    view: z.literal('unified').optional(),
  })
  .strict();

/** Owner-local read surface is independent of Live configuration and never exposes a writer. */
export const companionDecisionRoutes: FastifyPluginAsync<{ ownerUserId: string }> = async (app, options) => {
  app.get('/api/concierge/work/decisions', async (request, reply) => {
    reply.header('cache-control', 'no-store');
    const access = requirePluginOwnerLocalAccess(request, 'read');
    if ('error' in access) return reply.code(access.status).send({ error: access.error });
    if (access.operator !== options.ownerUserId) return reply.code(403).send({ error: 'Host owner required' });
    const page = pageSchema.safeParse(request.query);
    if (!page.success) return reply.code(400).send({ error: 'Invalid decision page' });
    const { offset, limit, view } = page.data;
    const result = await readCompanionDecisionProjection(app, access.operator, { offset, limit });
    const response = companionDecisionWireResponse(result, view);
    return reply.code(response.statusCode).send(response.body);
  });
};
