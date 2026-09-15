import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { CustodyOpportunityRuntime } from '../domains/growing/CustodyOpportunityRuntime.js';
import { resolveStrictUserId } from '../utils/request-identity.js';

const emptyBody = z.object({}).strict();
const snapshotParams = z.object({ snapshotRef: z.string().regex(/^f310_snapshot_[a-f0-9]{32}$/u) }).strict();

/** Owner-scoped evidence inspection; callers cannot supply source lists, timestamps or judgments. */
export function registerCustodyOpportunityRoutes(
  app: FastifyInstance,
  runtime: CustodyOpportunityRuntime | null,
): void {
  app.get('/api/entrusted-work/recognition-evidence', async (request, reply) => {
    const owner = resolveStrictUserId(request);
    if (!owner) return reply.status(401).send({ error: 'Identity required' });
    if (!runtime) return reply.status(503).send({ error: 'Recognition evidence unavailable' });
    return runtime.read(owner);
  });
  app.post('/api/entrusted-work/recognition-evidence/snapshots', async (request, reply) => {
    const owner = resolveStrictUserId(request);
    if (!owner) return reply.status(401).send({ error: 'Identity required' });
    if (!runtime) return reply.status(503).send({ error: 'Recognition evidence unavailable' });
    if (!emptyBody.safeParse(request.body ?? {}).success) {
      return reply.status(400).send({ error: 'Evidence sources and cutoffs are server-owned' });
    }
    return runtime.freeze(owner);
  });
  app.get('/api/entrusted-work/recognition-evidence/snapshots/:snapshotRef', async (request, reply) => {
    const owner = resolveStrictUserId(request);
    if (!owner) return reply.status(401).send({ error: 'Identity required' });
    if (!runtime) return reply.status(503).send({ error: 'Recognition evidence unavailable' });
    const parsed = snapshotParams.safeParse(request.params);
    if (!parsed.success) return reply.status(400).send({ error: 'Invalid evidence snapshot reference' });
    const snapshot = runtime.readFrozen(owner, parsed.data.snapshotRef);
    return snapshot ?? reply.status(404).send({ error: 'Evidence snapshot not found' });
  });
}
