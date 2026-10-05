import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import type { OwnerPageActionService } from '../domains/concierge/live/host/owner-page-action-service.js';
import { requirePluginOwnerLocalAccess } from './plugin-access-guards.js';

const id = z.string().uuid();
const inspectBody = z.object({ requestMessageId: z.string().regex(/^[A-Za-z0-9_-]{1,160}$/) }).strict();
const previewBody = z.object({ previewId: id }).strict();

export interface F317PageActionRouteOptions {
  ownerUserId: string;
  service: OwnerPageActionService;
}

/** Owner-only consent entry; no URL, selector, browser handle, or action is accepted over HTTP. */
export const f317PageActionRoutes: FastifyPluginAsync<F317PageActionRouteOptions> = async (app, options) => {
  app.addHook('preHandler', async (request, reply) => {
    const access = requirePluginOwnerLocalAccess(request, request.method === 'GET' ? 'read' : 'write');
    if ('error' in access) return reply.code(access.status).send({ error: access.error });
    if (access.operator !== options.ownerUserId) return reply.code(403).send({ error: 'Host owner required' });
  });

  app.get('/api/concierge/page-action', () => options.service.view());

  app.post('/api/concierge/page-action/inspect', async (request, reply) => {
    const parsed = inspectBody.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: 'Direct request required' });
    try {
      return { kind: 'awaiting_consent', preview: await options.service.inspect(parsed.data.requestMessageId) };
    } catch {
      return reply.code(409).send({ error: 'Page or direct request unavailable; refresh and inspect again' });
    }
  });

  app.post('/api/concierge/page-action/confirm', async (request, reply) => {
    const parsed = previewBody.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: 'Exact preview required' });
    try {
      return await options.service.confirm(parsed.data.previewId);
    } catch {
      return reply.code(409).send({ error: 'Page action preview expired or was consumed' });
    }
  });

  app.delete('/api/concierge/page-action', async (request, reply) => {
    const parsed = previewBody.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: 'Exact preview required' });
    try {
      options.service.cancel(parsed.data.previewId);
      return { cancellationRequested: true };
    } catch {
      return reply.code(409).send({ error: 'Page action preview unavailable' });
    }
  });

  app.addHook('onClose', () => options.service.close());
};
