import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { OwnerHomeActionService } from '../domains/concierge/live/host/home/owner-home-action-service.js';
import { resolveSessionUserId } from '../utils/request-identity.js';
import { type CallbackAuthRegistry, registerCallbackAuthHook } from './callback-auth-prehandler.js';

const consume = z
  .object({
    clientId: z.string().uuid(),
    clientToken: z.string().uuid(),
    expectedRevision: z.number().int().nonnegative().optional(),
  })
  .strict();

function homeOwnerSession(request: FastifyRequest, reply: FastifyReply, configuredOwner: string): string | null {
  const owner = resolveSessionUserId(request);
  if (!owner) reply.code(401).send({ error: 'Owner session required' });
  else if (owner !== configuredOwner) reply.code(403).send({ error: 'Configured home owner required' });
  else return owner;
  return null;
}

export const f317HomeOwnerRoutes: FastifyPluginAsync<{
  ownerUserId: string;
  isOwnerConnection?(ownerUserId: string, socketId: string): boolean;
  service: { hub: Pick<OwnerHomeActionService['hub'], 'consume' | 'registerClient' | 'unregisterClient'> };
}> = async (app, { ownerUserId, service, isOwnerConnection }) => {
  app.post('/api/concierge/home/clients', async (request, reply) => {
    const owner = homeOwnerSession(request, reply, ownerUserId);
    if (!owner) return reply;
    const parsed = z
      .object({ clientId: z.string().uuid(), socketId: z.string().min(1).max(128).optional() })
      .strict()
      .safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: 'Invalid home window' });
    if (parsed.data.socketId && !isOwnerConnection?.(owner, parsed.data.socketId))
      return reply.code(403).send({ error: 'Owner connection required' });
    return service.hub.registerClient(owner, parsed.data.clientId, parsed.data.socketId);
  });
  app.delete<{ Params: { clientId: string } }>('/api/concierge/home/clients/:clientId', async (request, reply) => {
    const owner = homeOwnerSession(request, reply, ownerUserId);
    if (!owner) return reply;
    const parsed = z.object({ clientToken: z.string().uuid() }).strict().safeParse(request.body);
    if (!parsed.success || !z.string().uuid().safeParse(request.params.clientId).success)
      return reply.code(400).send({ error: 'Invalid home window' });
    return { released: service.hub.unregisterClient(owner, request.params.clientId, parsed.data.clientToken) };
  });
  app.post<{ Params: { token: string } }>('/api/concierge/home/commands/:token', async (request, reply) => {
    const owner = homeOwnerSession(request, reply, ownerUserId);
    if (!owner) return reply;
    const parsed = consume.safeParse(request.body);
    if (!parsed.success || !z.string().uuid().safeParse(request.params.token).success)
      return reply.code(400).send({ error: 'Invalid home delivery receipt' });
    return service.hub.consume(
      owner,
      request.params.token,
      parsed.data.clientId,
      parsed.data.clientToken,
      parsed.data.expectedRevision,
    );
  });
};

export const f317LiveHomeRoutes: FastifyPluginAsync<{
  registry: CallbackAuthRegistry;
  service: Pick<OwnerHomeActionService, 'run'>;
}> = async (app, { registry, service }) => {
  registerCallbackAuthHook(app, registry);
  app.post('/api/callbacks/home-action', async (request, reply) => {
    const principal = request.callbackPrincipal;
    if (!principal || principal.kind !== 'invocation')
      return reply.code(401).send({ error: 'Live invocation required' });
    if (!z.object({}).strict().safeParse(request.body).success)
      return reply.code(400).send({ error: 'Request and target are Host-owned' });
    try {
      return (
        (await service.run(principal)) ?? { status: 'unavailable', reason: 'No current home request or Jev provider' }
      );
    } catch {
      return reply.code(403).send({ error: 'Current owner Live call required' });
    }
  });
};
