/**
 * InvocationRecord read projections.
 *
 * Failed-target retry belongs to the exact Queue-attempt endpoint on the source
 * message receipt. This route must never revive an old InvocationRecord or
 * launch an Agent Client outside Queue admission.
 */

import type { FastifyPluginAsync } from 'fastify';
import type { IInvocationRecordStore } from '../domains/cats/services/stores/ports/InvocationRecordStore.js';
import type { ITurnExecutionStore } from '../domains/cats/services/stores/ports/TurnExecutionStore.js';

export interface InvocationsRoutesOptions {
  invocationRecordStore: IInvocationRecordStore;
  turnExecutionStore?: Pick<ITurnExecutionStore, 'listByParent'>;
}

export const invocationsRoutes: FastifyPluginAsync<InvocationsRoutesOptions> = async (app, opts) => {
  app.get<{ Params: { id: string } }>('/api/invocations/:id', async (request, reply) => {
    const record = await opts.invocationRecordStore.get(request.params.id);
    if (!record) {
      reply.status(404);
      return { error: 'Invocation not found', code: 'INVOCATION_NOT_FOUND' };
    }
    return {
      id: record.id,
      threadId: record.threadId,
      userId: record.userId,
      userMessageId: record.userMessageId,
      targetCats: record.targetCats,
      intent: record.intent,
      status: record.status,
      ...(record.successfulCatIds ? { successfulCatIds: record.successfulCatIds } : {}),
      ...(record.error ? { error: record.error } : {}),
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
    };
  });

  // Durable child execution glass box. It intentionally does not read the
  // callback-auth registry, whose TTL is an authentication concern only.
  app.get<{ Params: { id: string } }>('/api/invocations/:id/executions', async (request, reply) => {
    if (!opts.turnExecutionStore) {
      reply.status(503);
      return { error: 'Turn execution ledger unavailable', code: 'TURN_EXECUTION_LEDGER_UNAVAILABLE' };
    }
    const executions = await opts.turnExecutionStore.listByParent(request.params.id);
    if (executions.length === 0) {
      reply.status(404);
      return { error: 'Turn executions not found', code: 'TURN_EXECUTIONS_NOT_FOUND' };
    }
    return {
      parentInvocationId: request.params.id,
      executionCount: executions.length,
      executions,
    };
  });
};
