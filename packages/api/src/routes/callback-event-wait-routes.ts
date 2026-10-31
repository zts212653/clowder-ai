import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  EventWaitDispositionError,
  type EventWaitDispositionService,
} from '../domains/ball-custody/EventWaitDispositionService.js';
import { EVENT_WAIT_DISPOSITIONS } from '../domains/ball-custody/event-wait-events.js';
import { requireCallbackAuth } from './callback-auth-prehandler.js';

export interface EventWaitDispositionRouteDeps {
  /** Present only where the ball ledger is wired (Redis). Absent means this runtime cannot answer. */
  eventWaitDispositionService?: Pick<EventWaitDispositionService, 'complete'>;
}

/**
 * Strict on purpose: the caller picks the disposition and nothing else. The wake, its carrier and the holder are
 * derived from the authenticated invocation, so no body key can name another thread, wait, outcome or message.
 */
const completeEventWaitBodySchema = z.object({ disposition: z.enum(EVENT_WAIT_DISPOSITIONS) }).strict();

/**
 * F167: the completion terminal for a matched event-wait wake. Invocation identity only (an agent key carries no
 * invocation), symmetric with `complete-managed-hold` / `complete-a2a-dispatch`.
 */
export function registerEventWaitDispositionRoutes(app: FastifyInstance, deps: EventWaitDispositionRouteDeps): void {
  app.post('/api/callbacks/complete-event-wait', async (request, reply) => {
    const record = requireCallbackAuth(request, reply);
    if (!record) return;
    if (!deps.eventWaitDispositionService) {
      reply.status(503);
      return { error: 'Event wait disposition unavailable', code: 'EVENT_WAIT_DISPOSITION_UNAVAILABLE' };
    }
    const parsed = completeEventWaitBodySchema.safeParse(request.body);
    if (!parsed.success) {
      reply.status(400);
      return { error: 'Invalid request body', details: parsed.error.issues };
    }
    try {
      return await deps.eventWaitDispositionService.complete(record, parsed.data.disposition);
    } catch (error) {
      if (error instanceof EventWaitDispositionError) {
        reply.status(409);
        return { error: 'Event wait disposition rejected', code: error.code };
      }
      throw error;
    }
  });
}
