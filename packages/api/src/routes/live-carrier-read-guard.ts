import type { FastifyReply, FastifyRequest } from 'fastify';
import type { ITurnExecutionStore } from '../domains/cats/services/stores/ports/TurnExecutionStore.js';

interface LiveReadGuardDeps {
  turnExecutionStore?: Pick<ITurnExecutionStore, 'get'>;
  withLiveCarrierOperation?: <T>(
    query: { invocationId: string; catId: string; threadId: string },
    operation: () => Promise<T>,
  ) => Promise<T>;
}

/** The accepted full-read handler drains before the Live outer invocation terminates. */
export function guardLiveCarrierRead(
  deps: LiveReadGuardDeps,
  handler: (request: FastifyRequest, reply: FastifyReply) => Promise<unknown>,
): (request: FastifyRequest, reply: FastifyReply) => Promise<unknown> {
  return async (request, reply) => {
    const auth = request.callbackAuth;
    if (auth && deps.withLiveCarrierOperation && deps.turnExecutionStore) {
      const execution = await deps.turnExecutionStore.get(auth.invocationId);
      if (execution?.queueCompletionPolicy === 'explicit_source') {
        return deps.withLiveCarrierOperation(
          { invocationId: auth.invocationId, catId: auth.catId, threadId: auth.threadId },
          () => handler(request, reply),
        );
      }
    }
    return handler(request, reply);
  };
}
