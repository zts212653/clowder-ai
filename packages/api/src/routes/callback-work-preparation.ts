import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { InvocationRecord } from '../domains/cats/services/agents/invocation/InvocationRegistry.js';
import type { MemoryCueDrillCoordinate } from '../domains/memory/cue/MemoryCueDrillHandleService.js';
import type { MemoryCueInvalidationReason } from '../domains/memory/cue/MemoryCueEpisodeStore.js';
import { requireCallbackAuth } from './callback-auth-prehandler.js';

export const preparationBodySchema = z
  .object({
    activity: z.enum(['html', 'video']),
    query: z.string().trim().min(1).max(500),
  })
  .strict();

export interface WorkPreparationCallback {
  recordInvalidation(
    coordinate: MemoryCueDrillCoordinate,
    reason: MemoryCueInvalidationReason,
    occurredAt: number,
  ): void;
  recordRead(coordinate: MemoryCueDrillCoordinate, requestId: string, occurredAt: number): void;
  prepare(
    input: z.infer<typeof preparationBodySchema> & {
      auth: InvocationRecord;
      receivedAt: number;
      signal: AbortSignal;
    },
  ): Promise<unknown>;
}

export function registerCallbackWorkPreparation(
  app: FastifyInstance,
  preparation: Pick<WorkPreparationCallback, 'prepare'> | undefined,
  now: () => number,
): void {
  app.post('/api/callbacks/memory-cues/prepare', async (request, reply) => {
    const auth = requireCallbackAuth(request, reply);
    if (!auth) return;
    const receivedAt = now();
    const parsed = preparationBodySchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: 'invalid_preparation', details: parsed.error.flatten() });
    if (!preparation) return { status: 'not_available', delivery: 'unknown', pointers: [] };
    const controller = new AbortController();
    const abort = () => controller.abort();
    const closed = () => {
      if (!reply.raw.writableFinished) abort();
    };
    request.raw.once('aborted', abort);
    reply.raw.once('close', closed);
    try {
      return await preparation.prepare({ ...parsed.data, auth, receivedAt, signal: controller.signal });
    } finally {
      request.raw.off('aborted', abort);
      reply.raw.off('close', closed);
    }
  });
}
