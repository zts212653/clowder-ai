import { humanDispositionFeedbackInputSchema } from '@cat-cafe/shared';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { WaitTerminationService } from '../domains/ball-custody/WaitTerminationService.js';
import { resolveStrictUserId } from '../utils/request-identity.js';

const paramsSchema = z.object({ taskId: z.string().trim().min(1).max(200) }).strict();
const cancelBodySchema = z.object({ feedback: z.unknown().optional() }).strict();

export interface WaitTerminationRouteDeps {
  service: WaitTerminationService | null;
}

interface RouteOutcome {
  status: number;
  body: unknown;
}

function resultOutcome(result: Awaited<ReturnType<WaitTerminationService['cancelByUser']>>): RouteOutcome {
  if (result.outcome === 'not_found') return { status: 404, body: { error: 'wait_not_found' } };
  if (result.outcome === 'forbidden') return { status: 403, body: { error: 'not_authorized' } };
  if (result.outcome === 'execution_started') {
    return { status: 409, body: { error: 'wait_execution_started' } };
  }
  if (result.outcome === 'conflict') {
    return { status: 409, body: { error: 'feedback_conflict', event: result.record?.event } };
  }
  return {
    status: result.projectionPending ? 202 : 200,
    body: {
      status: result.projectionPending ? 'committed_projection_pending' : 'ok',
      deduped: result.outcome === 'replay',
      event: result.record?.event,
    },
  };
}

async function cancelOutcome(
  request: Parameters<WaitTerminationService['cancelByUser']>[0] & { service: WaitTerminationService },
): Promise<RouteOutcome> {
  return resultOutcome(
    await request.service.cancelByUser({
      waitId: request.waitId,
      ownerUserId: request.ownerUserId,
      ...(request.feedback ? { feedback: request.feedback } : {}),
    }),
  );
}

export function registerWaitTerminationRoutes(app: FastifyInstance, deps: WaitTerminationRouteDeps): void {
  app.post('/api/waits/hold-ball/:taskId/cancel', async (request, reply) => {
    const ownerUserId = resolveStrictUserId(request);
    if (!ownerUserId) {
      reply.status(401);
      return { error: 'identity_required' };
    }
    if (!deps.service) {
      reply.status(503);
      return { error: 'durable_store_unavailable' };
    }
    const params = paramsSchema.safeParse(request.params);
    const body = cancelBodySchema.safeParse(request.body ?? {});
    if (!params.success || !body.success) {
      reply.status(400);
      return { error: 'invalid_request' };
    }
    const feedback = humanDispositionFeedbackInputSchema.optional().safeParse(body.data.feedback);
    if (!feedback.success) {
      reply.status(400);
      return { error: 'invalid_feedback', details: feedback.error.issues };
    }

    const outcome = await cancelOutcome({
      service: deps.service,
      waitId: params.data.taskId,
      ownerUserId,
      ...(feedback.data ? { feedback: feedback.data } : {}),
    });
    reply.status(outcome.status);
    return outcome.body;
  });
}
