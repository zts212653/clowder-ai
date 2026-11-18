import { quotaPinPreferencePatchSchema } from '@cat-cafe/shared';
import type { FastifyInstance } from 'fastify';
import { readQuotaPinPreferenceStrict, saveQuotaPinPreference } from '../config/user-preferences-quota-pin.js';
import { resolveOwnerGate } from '../utils/owner-gate.js';
import { resolveStrictUserId } from '../utils/request-identity.js';

/** Durable owner preference for the sidebar quota summary ring; no TTL and no probe side effects. */
export async function configQuotaPinRoutes(app: FastifyInstance, opts: { projectRoot: string }): Promise<void> {
  app.addHook('preHandler', async (request, reply) => {
    const userId = resolveStrictUserId(request);
    if (!userId) return reply.status(401).send({ error: 'Owner identity required' });
    const gate = resolveOwnerGate(userId);
    if (gate) return reply.status(gate.status).send({ error: gate.error });
  });

  app.get('/api/config/quota-pin', async (_request, reply) => {
    try {
      return readQuotaPinPreferenceStrict(opts.projectRoot);
    } catch {
      return reply.status(503).send({ error: 'Quota pin preferences unavailable' });
    }
  });

  app.put('/api/config/quota-pin', async (request, reply) => {
    const parsed = quotaPinPreferencePatchSchema.safeParse(request.body);
    if (!parsed.success) return reply.status(400).send({ error: 'Invalid quota pin preference' });
    try {
      return saveQuotaPinPreference(opts.projectRoot, parsed.data);
    } catch {
      return reply.status(503).send({ error: 'Quota pin preferences unavailable' });
    }
  });
}
