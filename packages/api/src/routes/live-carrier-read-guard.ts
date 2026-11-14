import type { FastifyReply, FastifyRequest } from 'fastify';
import type {
  ITurnExecutionStore,
  TurnExecutionRecord,
} from '../domains/cats/services/stores/ports/TurnExecutionStore.js';
import { LiveCarrierUnavailableError } from '../domains/concierge/live/LiveCarrierOperationGate.js';

const watcherReads = new WeakSet<object>();

/** Only a verified canonical child can mark a request as an observer read. */
export function isWatcherRead(request: FastifyRequest): boolean {
  return watcherReads.has(request);
}

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
    if (auth?.toolExecutionPolicy?.mode === 'watcher' && !deps.turnExecutionStore)
      return reply.code(503).send({ error: 'Watcher execution evidence unavailable' });
    if (auth && deps.turnExecutionStore) {
      let execution: TurnExecutionRecord | null;
      try {
        execution = await deps.turnExecutionStore.get(auth.invocationId);
      } catch {
        return reply.code(503).send({ error: 'Execution evidence unavailable' });
      }
      if (auth.toolExecutionPolicy?.mode === 'watcher' && execution?.executionKind !== 'watcher')
        return reply.code(409).send({ error: 'Watcher execution evidence missing' });
      if (execution?.executionKind === 'watcher') {
        if (
          execution.status !== 'running' ||
          execution.userId !== auth.userId ||
          execution.catId !== auth.catId ||
          execution.threadId !== auth.threadId ||
          execution.parentInvocationId !== (auth.parentInvocationId ?? auth.invocationId)
        )
          return reply.code(409).send({ error: 'Watcher execution scope mismatch' });
        watcherReads.add(request);
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
