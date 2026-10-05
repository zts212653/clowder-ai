import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  CUSTODY_INSPECT_MAX_LIMIT,
  type CustodyEventInspector,
} from '../domains/ball-custody/CustodyEventInspector.js';
import { requireCallbackPrincipal } from './callback-auth-prehandler.js';

export interface CustodyEventRouteDeps {
  /** Present only where the ball ledger is wired (Redis). Absent means this runtime cannot answer. */
  custodyEventInspector?: Pick<CustodyEventInspector, 'inspect'>;
}

/**
 * Strict on purpose: the thread is never a request parameter, so `?threadId=` (or any other extra key) is a 400
 * rather than being silently ignored. A caller who thinks they asked for another thread learns they did not.
 */
const custodyEventsQuerySchema = z
  .object({
    sourceMessageId: z.string().min(1).max(200),
    limit: z.coerce.number().int().min(1).max(CUSTODY_INSPECT_MAX_LIMIT).optional(),
  })
  .strict();

/**
 * F167 PR-2: read-only view of the caller's own thread's ball ledger, anchored on a source message.
 *
 * Invocation identity only. The thread comes from the authenticated invocation and nothing else; an agent key
 * carries no thread and is refused. Whatever cannot be answered is said so in the response: an unreadable ledger
 * is a 503 with its reason and a runtime without the ledger is a 503 of its own, never a 200 with an empty list.
 */
export function registerCustodyEventRoutes(app: FastifyInstance, deps: CustodyEventRouteDeps): void {
  app.get('/api/callbacks/custody-events', async (request, reply) => {
    const principal = requireCallbackPrincipal(request, reply);
    if (!principal) return;

    if (principal.kind !== 'invocation') {
      reply.status(403);
      return { error: 'Custody events require invocation-scoped auth (not agent_key)' };
    }

    const parsed = custodyEventsQuerySchema.safeParse(request.query);
    if (!parsed.success) {
      reply.status(400);
      return { error: 'Invalid query', details: parsed.error.issues };
    }

    if (!deps.custodyEventInspector) {
      reply.status(503);
      return {
        code: 'CUSTODY_INSPECTOR_UNAVAILABLE',
        error: 'This runtime has no ball custody ledger to read',
      };
    }

    const { sourceMessageId, limit } = parsed.data;
    const inspection = await deps.custodyEventInspector.inspect({
      threadId: principal.threadId,
      sourceMessageId,
      ...(limit !== undefined ? { limit } : {}),
    });
    if (inspection.status === 'unavailable') reply.status(503);
    return inspection;
  });
}
