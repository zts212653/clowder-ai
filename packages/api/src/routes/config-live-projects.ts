import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { readUserPreferencesStrict, updateUserPreferences } from '../config/user-preferences-store.js';
import { resolveOwnerGate } from '../utils/owner-gate.js';
import { resolveStrictUserId } from '../utils/request-identity.js';

const sectionSchema = z.object({ section: z.enum(['live', 'waiting', 'deployment']).default('live') }).strict();
const fields = { live: 'liveProjectFolds', waiting: 'waitingProjectFolds', deployment: 'deploymentWaitFolds' } as const;
const foldsSchema = z.record(z.string(), z.boolean());
const mutationSchema = z.object({ projectPath: z.string().min(1).max(4096), collapsed: z.boolean() }).strict();

/** Same private, durable preference owner as conversation view; no execution mutation. */
export async function configLiveProjectRoutes(app: FastifyInstance, opts: { projectRoot: string }): Promise<void> {
  app.addHook('preHandler', async (request, reply) => {
    const userId = resolveStrictUserId(request);
    if (!userId) return reply.status(401).send({ error: 'Owner identity required' });
    const gate = resolveOwnerGate(userId);
    if (gate) return reply.status(gate.status).send({ error: gate.error });
  });
  app.get('/api/config/live-projects', async (request, reply) => {
    const section = sectionSchema.safeParse(request.query);
    if (!section.success) return reply.status(400).send({ error: 'Invalid Home fold section' });
    try {
      return {
        collapsed: foldsSchema.parse(readUserPreferencesStrict(opts.projectRoot)[fields[section.data.section]] ?? {}),
      };
    } catch {
      return reply.status(503).send({ error: 'Project display preferences unavailable' });
    }
  });
  app.put('/api/config/live-projects', async (request, reply) => {
    const section = sectionSchema.safeParse(request.query);
    if (!section.success) return reply.status(400).send({ error: 'Invalid Home fold section' });
    const field = fields[section.data.section];
    const parsed = mutationSchema.safeParse(request.body);
    if (!parsed.success) return reply.status(400).send({ error: 'Invalid project display preference' });
    try {
      const { projectPath, collapsed } = parsed.data;
      const preferences = updateUserPreferences(
        opts.projectRoot,
        (current) => ({
          ...current,
          [field]: { ...foldsSchema.parse(current[field] ?? {}), [projectPath]: collapsed },
        }),
        { strictRead: true },
      );
      return { collapsed: preferences[field] };
    } catch {
      return reply.status(503).send({ error: 'Project display preferences unavailable' });
    }
  });
}
