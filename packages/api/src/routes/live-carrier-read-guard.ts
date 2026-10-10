import type { FastifyReply, FastifyRequest } from 'fastify';
import type {
  ITurnExecutionStore,
  TurnExecutionRecord,
} from '../domains/cats/services/stores/ports/TurnExecutionStore.js';
import { LiveCarrierUnavailableError } from '../domains/concierge/live/LiveCarrierOperationGate.js';

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
    if (auth && deps.turnExecutionStore) {
      let execution: TurnExecutionRecord | null;
      try {
        execution = await deps.turnExecutionStore.get(auth.invocationId);
      } catch {
        return reply.code(503).send({ error: 'Execution evidence unavailable' });
      }
      if (execution?.queueCompletionPolicy === 'explicit_source') {
        if (
          !deps.withLiveCarrierOperation ||
          execution.invocationId !== auth.invocationId ||
          execution.parentInvocationId !== (auth.parentInvocationId ?? auth.invocationId) ||
          execution.userId !== auth.userId ||
          execution.threadId !== auth.threadId ||
          execution.catId !== auth.catId ||
          execution.status !== 'running'
        )
          throw new LiveCarrierUnavailableError();
        return deps.withLiveCarrierOperation(
          { invocationId: auth.invocationId, catId: auth.catId, threadId: auth.threadId },
          () => handler(request, reply),
        );
      }
    }
    return handler(request, reply);
  };
}
