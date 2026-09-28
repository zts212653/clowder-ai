import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { CollectiveCurrentContext } from '../domains/plugin/builtin-runtime/collective-current-context.js';
import {
  type CallbackAuthRegistry,
  registerCallbackAuthHook,
  requireCallbackAuth,
} from './callback-auth-prehandler.js';

const currentSchema = z.object({}).strict();
const readSchema = z
  .object({
    contextRef: z.string().min(1).max(256),
    afterSequence: z.number().int().nonnegative().default(0),
    limit: z.number().int().min(1).max(100).default(30),
  })
  .strict();
const replySchema = z
  .object({
    returnRef: z.string().min(1).max(256),
    replyOperationRef: z.string().min(1).max(256),
    body: z.string().trim().min(1).max(20000),
  })
  .strict();

export async function registerCollectiveParticipationCallbacks(
  app: FastifyInstance,
  options: {
    registry: CallbackAuthRegistry;
    context: CollectiveCurrentContext;
  },
) {
  await app.register(async (scope) => {
    registerCallbackAuthHook(scope, options.registry);
    for (const name of ['current-context', 'read-context', 'reply'] as const) {
      scope.post(`/api/callbacks/collective-${name}`, async (request, reply) => {
        const auth = requireCallbackAuth(request, reply);
        if (!auth) return;
        try {
          if (name === 'current-context') {
            currentSchema.parse(request.body ?? {});
            return await options.context.current(auth);
          }
          if (name === 'read-context') {
            const input = readSchema.parse(request.body);
            return await options.context.read(auth, input.contextRef, input.afterSequence, input.limit);
          }
          const input = replySchema.parse(request.body);
          return await options.context.reply(auth, input.returnRef, input.replyOperationRef, input.body);
        } catch (error) {
          if (error instanceof z.ZodError)
            return reply.status(400).send({ code: 'INVALID_COLLECTIVE_REQUEST', error: error.message });
          const code =
            error instanceof Error && 'code' in error && typeof error.code === 'string'
              ? error.code
              : 'RETURN_UNAVAILABLE';
          return reply
            .status(code === 'RETURN_REF_INVALID' ? 403 : 409)
            .send({ code, error: error instanceof Error ? error.message : 'Collective source unavailable' });
        }
      });
    }
  });
}
