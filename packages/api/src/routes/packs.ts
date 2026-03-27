/**
 * F129 Pack Routes
 * POST /api/packs/add    — Install a pack from local directory path (Phase A: local only)
 * GET  /api/packs         — List installed packs
 * DELETE /api/packs/:name — Remove a pack
 */

import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import type { PackLoader } from '../domains/packs/PackLoader.js';

const addSchema = z.object({
  source: z.string().min(1),
});

export interface PacksRoutesOptions {
  packLoader: PackLoader;
}

export const packsRoutes: FastifyPluginAsync<PacksRoutesOptions> = async (app, opts) => {
  const { packLoader } = opts;

  app.post('/api/packs/add', async (request, reply) => {
    const parseResult = addSchema.safeParse(request.body);
    if (!parseResult.success) {
      reply.status(400);
      return { error: 'Invalid request', details: parseResult.error.issues };
    }

    try {
      const manifest = await packLoader.add(parseResult.data.source);
      reply.status(201);
      return { ok: true, manifest };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const isSecurityError = msg.includes('security') || msg.includes('Security');
      reply.status(isSecurityError ? 403 : 400);
      return { ok: false, error: msg };
    }
  });

  app.get('/api/packs', async () => {
    const packs = await packLoader.list();
    return { packs };
  });

  app.delete('/api/packs/:name', async (request, reply) => {
    const { name } = request.params as { name: string };
    if (!name || typeof name !== 'string') {
      reply.status(400);
      return { error: 'Pack name required' };
    }

    const removed = await packLoader.remove(name);
    return { removed };
  });
};
