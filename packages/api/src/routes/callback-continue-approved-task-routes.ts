import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { InvocationRegistry } from '../domains/cats/services/agents/invocation/InvocationRegistry.js';
import type { IProposalStore } from '../domains/cats/services/stores/ports/ProposalStore.js';
import { requireCallbackAuth } from './callback-auth-prehandler.js';

const bodySchema = z
  .object({
    proposalId: z.string().trim().min(1).max(200),
    taskId: z.string().trim().min(1).max(200),
    clientRequestId: z.string().trim().min(1).max(200),
  })
  .strict();

export function registerCallbackContinueApprovedTaskRoutes(
  app: FastifyInstance,
  deps: {
    registry: InvocationRegistry;
    proposalStore: IProposalStore;
  },
): void {
  app.post('/api/callbacks/continue-approved-task', async (request, reply) => {
    const record = requireCallbackAuth(request, reply);
    if (!record) return;
    const parsed = bodySchema.safeParse(request.body);
    if (!parsed.success) {
      return reply
        .code(400)
        .send({ error: 'Expected proposalId, taskId and clientRequestId only', details: parsed.error.issues });
    }
    if (!(await deps.registry.isLatest(record.invocationId))) return { status: 'stale_ignored' };
    const result = await deps.proposalStore.continueApprovedTask({
      ...parsed.data,
      actor: { userId: record.userId, catId: record.catId, threadId: record.threadId },
    });
    if (result.outcome === 'rejected') return reply.code(result.reason === 'unavailable' ? 503 : 409).send(result);
    return result;
  });
}
