import type Database from 'better-sqlite3';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { eventMemoryRevision } from '../domains/memory/EventMemoryStore.js';
import type { MemoryReadItem } from '../domains/memory/read-usage/MemoryDirectReadEvidence.js';
import { readMemoryUsage } from '../domains/memory/read-usage/MemoryReadUsageReader.js';
import { resolveSessionUserId } from '../utils/request-identity.js';
import type { EventsRoutesOptions } from './events.js';
import { finishMemoryDirectRead } from './memory-direct-read-response.js';
import { projectMemoryUsageThreads } from './memory-usage-threads.js';

export function finishEventRead<T extends object>(
  request: FastifyRequest,
  reply: FastifyReply,
  db: Database.Database | undefined,
  result: T,
  items: readonly { eventId: string; revision: string; summaryTruncated?: boolean }[],
) {
  const principal = request.callbackPrincipal;
  // Browser reads, even if supplied a request-id query, are not model reads.
  if (!principal || resolveSessionUserId(request)) return result;
  const parsed = z
    .string()
    .trim()
    .min(1)
    .max(200)
    .optional()
    .safeParse((request.query as { readRequestId?: unknown }).readRequestId);
  if (!parsed.success) return reply.code(400).send({ error: 'invalid_read_request' });
  const observations: MemoryReadItem[] = items
    .filter((item) => !item.summaryTruncated)
    .map((item) => ({
      family: 'event',
      anchor: `event-memory:${item.eventId}`,
      sourceRevision: item.revision,
      memoryRevision: item.revision,
    }));
  return finishMemoryDirectRead(request, reply, db, principal, parsed.data, result, observations);
}

export function registerEventMemoryUsage(app: FastifyInstance, opts: EventsRoutesOptions) {
  app.get<{ Params: { eventId: string }; Querystring: { revision?: string } }>(
    '/api/memory/events/:eventId/usage',
    async (request, reply) => {
      const owner = resolveSessionUserId(request);
      if (!owner) return reply.code(401).send({ error: 'Session required' });
      const revision = request.query.revision;
      if (!revision || !/^sha256:[a-f0-9]{64}$/.test(revision))
        return reply.code(400).send({ error: 'Revision required' });
      const event = opts.eventMemoryStore.getEvent(request.params.eventId);
      if (!event || event.ownerUserId !== owner) return reply.code(404).send({ error: 'not_available' });
      if (eventMemoryRevision(event) !== revision) return reply.code(409).send({ error: 'Revision changed' });
      if (!opts.readEvidenceDb) return reply.code(503).send({ error: 'usage_unavailable' });
      try {
        return await projectMemoryUsageThreads(
          readMemoryUsage(opts.readEvidenceDb, {
            owner,
            family: 'event',
            anchor: `event-memory:${event.eventId}`,
            revision,
            cueRevision: revision,
          }),
          owner,
          opts.threadStore,
        );
      } catch (error) {
        request.log.warn({ err: error }, 'Event usage unavailable');
        return reply.code(503).send({ error: 'usage_unavailable' });
      }
    },
  );
}
