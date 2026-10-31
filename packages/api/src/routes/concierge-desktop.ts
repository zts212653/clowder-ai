import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { DesktopWindowPresence } from '../domains/plugin/desktop-window-runtime/types.js';
import { requirePluginOwnerLocalAccess } from './plugin-access-guards.js';

export interface ConciergeDesktopOptions {
  ownerUserId: string;
  desktop:
    | {
        presence(): Promise<DesktopWindowPresence | null>;
        hasUnexpectedLoss?(): Promise<boolean>;
        unexpectedLossId?(): Promise<string | null>;
        show(): Promise<void>;
      }
    | undefined;
  now?: () => number;
}
export function registerConciergeDesktopRoutes(app: FastifyInstance, options: ConciergeDesktopOptions): void {
  const observe = async () => {
    const presence = await options.desktop?.presence();
    const maxAgeMs = presence ? Math.min(15_000, presence.expiresAt - (options.now ?? Date.now)()) : 0;
    if (presence && maxAgeMs > 0) return { presence: { state: presence.state, maxAgeMs } };
    if (options.desktop?.unexpectedLossId) {
      const lossId = await options.desktop.unexpectedLossId();
      return lossId ? { presence: null, desktopLost: true, lossId } : { presence: null, desktopLost: false };
    }
    const desktopLost = await options.desktop?.hasUnexpectedLoss?.();
    return { presence: null, desktopLost: desktopLost === true };
  };
  const requireOwner = async (
    request: Parameters<typeof requirePluginOwnerLocalAccess>[0],
    reply: import('fastify').FastifyReply,
  ) => {
    const access = requirePluginOwnerLocalAccess(request, request.method === 'GET' ? 'read' : 'write');
    if ('error' in access) return reply.code(access.status).send({ error: access.error });
    if (access.operator !== options.ownerUserId) return reply.code(403).send({ error: 'Host owner required' });
  };
  app.get('/api/concierge/desktop', { preHandler: requireOwner }, async (request, reply) => {
    reply.header('Cache-Control', 'no-store');
    try {
      return await observe();
    } catch {
      request.log.warn({ code: 'desktop_presence_unavailable' }, 'Companion presence unavailable');
      return reply.code(503).send({ code: 'desktop_presence_unavailable' });
    }
  });
  app.post('/api/concierge/desktop/show', { preHandler: requireOwner }, async (request, reply) => {
    if (
      !z
        .object({})
        .strict()
        .safeParse(request.body ?? {}).success
    )
      return reply.code(400).send({ error: 'No window selectors accepted' });
    try {
      if (!options.desktop) throw new Error('unavailable');
      await options.desktop.show();
      return await observe();
    } catch {
      return reply.code(409).send({ code: 'desktop_unavailable', presence: null });
    }
  });
}
