import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import {
  RuntimeInteractionError,
  type RuntimeInteractionService,
} from '../domains/runtime-interaction/RuntimeInteractionService.js';
import { resolveStrictUserId } from '../utils/request-identity.js';

export interface RuntimeInteractionRoutesOptions {
  service: RuntimeInteractionService;
}

const paramsSchema = z.object({ interactionId: z.string().trim().min(1) }).strict();
const cardRefSchema = z
  .object({
    threadId: z.string().trim().min(1),
    messageId: z.string().trim().min(1),
    blockId: z.string().trim().min(1),
  })
  .strict();
const respondBodySchema = z
  .object({
    cardRef: cardRefSchema,
    response: z.unknown(),
  })
  .strict();

export const runtimeInteractionRoutes: FastifyPluginAsync<RuntimeInteractionRoutesOptions> = async (app, options) => {
  app.get('/api/runtime-interactions/:interactionId', async (request, reply) => {
    const ownerUserId = resolveStrictUserId(request);
    if (!ownerUserId) {
      reply.status(401);
      return { error: 'Identity required' };
    }
    const params = paramsSchema.safeParse(request.params);
    if (!params.success) {
      reply.status(400);
      return { error: 'Invalid interaction id' };
    }
    const interaction = await options.service.getForOwner(params.data.interactionId, ownerUserId);
    if (!interaction) {
      reply.status(404);
      return { error: 'Interaction not found' };
    }
    return { interaction };
  });

  app.post('/api/runtime-interactions/:interactionId/respond', async (request, reply) => {
    const ownerUserId = resolveStrictUserId(request);
    if (!ownerUserId) {
      reply.status(401);
      return { error: 'Authenticated owner session required' };
    }
    const params = paramsSchema.safeParse(request.params);
    const body = respondBodySchema.safeParse(request.body);
    if (!params.success || !body.success) {
      reply.status(400);
      return { error: 'Invalid runtime interaction response' };
    }
    try {
      const interaction = await options.service.respond({
        interactionId: params.data.interactionId,
        ownerUserId,
        cardRef: body.data.cardRef,
        response: body.data.response,
      });
      return { interaction };
    } catch (error) {
      return mapInteractionError(error, reply);
    }
  });
};

function mapInteractionError(
  error: unknown,
  reply: import('fastify').FastifyReply,
): { error: string; reasonCode?: string } {
  if (!(error instanceof RuntimeInteractionError)) throw error;
  switch (error.code) {
    case 'not_found':
    case 'unauthorized':
      reply.status(404);
      return { error: 'Interaction not found' };
    case 'invalid_response':
      reply.status(400);
      return { error: error.message };
    case 'stale':
    case 'unavailable':
      reply.status(409);
      return { error: error.message, ...(error.reasonCode ? { reasonCode: error.reasonCode } : {}) };
    case 'duplicate':
      reply.status(409);
      return { error: error.message };
  }
}
