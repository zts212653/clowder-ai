import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { readConsoleThemes, saveConsoleThemes } from '../config/user-preferences-console-themes.js';
import { resolveOwnerGate } from '../utils/owner-gate.js';
import { resolveStrictUserId } from '../utils/request-identity.js';

const saveSchema = z.object({ themes: z.record(z.unknown()) }).strict();

/** The console's custom themes live in the owner's preferences, so clearing the browser keeps them. */
export async function configConsoleThemeRoutes(app: FastifyInstance, opts: { projectRoot: string }): Promise<void> {
  function owner(request: FastifyRequest, reply: FastifyReply): string | null {
    const userId = resolveStrictUserId(request);
    if (!userId) {
      reply.code(401);
      return null;
    }
    const denied = resolveOwnerGate(userId);
    if (denied) {
      reply.code(denied.status);
      return null;
    }
    return userId;
  }

  app.get('/api/config/console-themes', async (request, reply) => {
    const ownerUserId = owner(request, reply);
    if (!ownerUserId) return { error: 'Owner identity required' };
    return { themes: readConsoleThemes(opts.projectRoot, ownerUserId) };
  });

  app.post('/api/config/console-themes', async (request, reply) => {
    const ownerUserId = owner(request, reply);
    if (!ownerUserId) return { error: 'Owner identity required' };
    const parsed = saveSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: 'Invalid themes' });
    saveConsoleThemes(opts.projectRoot, ownerUserId, parsed.data.themes);
    return { themes: parsed.data.themes };
  });
}
