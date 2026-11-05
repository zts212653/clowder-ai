import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { InvocationRegistry } from '../domains/cats/services/agents/invocation/InvocationRegistry.js';
import type { CloudReturnGrantStore } from '../domains/cats/services/cloud-bridge/cloud-return-grant.js';
import type { IThreadStore } from '../domains/cats/services/stores/ports/ThreadStore.js';
import type { MessageSearchAnswerPublicationService } from '../domains/memory/MessageSearchAnswerPublicationService.js';
import { MessageSearchAccessError } from '../domains/memory/MessageSearchService.js';
import { requireCallbackAuth, requireCallbackPrincipal } from './callback-auth-prehandler.js';
import { getDeletedCallbackThreadGuard, resolvePrincipalThread } from './callback-scope-helpers.js';
import {
  executeMessageSearchOperation,
  messageSearchQuerySchema,
  toMessageSearchInput,
} from './message-search-handler.js';

const bodySchema = z
  .object({
    operationId: z.string().min(1).max(200),
    destinationThreadId: z.string().min(1).max(256).optional(),
    replyTo: z.string().min(1).max(256).optional(),
  })
  .and(messageSearchQuerySchema)
  .refine((value) => value.resultUnit === 'message', { message: 'Answer publication requires message search' });

export function registerCallbackMessageSearchAnswerRoutes(
  app: FastifyInstance,
  deps: {
    service?: MessageSearchAnswerPublicationService;
    threadStore?: Pick<IThreadStore, 'get' | 'list'>;
    registry?: Pick<InvocationRegistry, 'isLatest'>;
    cloudReturnGrantStore?: Pick<CloudReturnGrantStore, 'claim' | 'release'>;
  },
) {
  app.post('/api/callbacks/search-evidence/answer', async (request, reply) => {
    const principal = requireCallbackPrincipal(request, reply);
    if (!principal) return;
    const parsed = bodySchema.safeParse(request.body);
    if (!parsed.success)
      return reply.status(400).send({ error: 'Invalid answer request', details: parsed.error.issues });
    if (principal.kind === 'invocation' && !(await deps.registry?.isLatest(principal.invocationId)))
      return reply.status(409).send({ status: 'stale_ignored' });
    if (
      principal.kind === 'invocation' &&
      parsed.data.destinationThreadId &&
      parsed.data.destinationThreadId !== principal.threadId
    )
      return reply.status(403).send({ error: 'Answer destination must match the authenticated invocation thread' });
    const scope = await resolvePrincipalThread(principal, parsed.data.destinationThreadId, {
      threadStore: deps.threadStore,
    });
    if (!scope.ok) return reply.status(scope.statusCode).send({ error: scope.error });
    const deleted = await getDeletedCallbackThreadGuard(deps.threadStore, scope.threadId);
    if (deleted) return reply.status(deleted.statusCode).send(deleted.body);
    if (!deps.service) return reply.status(503).send({ error: 'Answer publication unavailable' });
    const record = principal.kind === 'invocation' ? requireCallbackAuth(request, reply) : null;
    const cloud =
      principal.kind === 'agent_key' && (principal.cloudBoundary || principal.scope === 'cloud-conversation');
    const sourceId =
      record?.originTriggerMessageId ?? record?.a2aTriggerMessageId ?? (cloud ? parsed.data.replyTo : undefined);
    if (cloud && (!sourceId || !deps.cloudReturnGrantStore))
      return reply.status(403).send({ error: 'Exact Host cloud return grant required' });
    return executeMessageSearchOperation(
      (execution) =>
        deps.service!.prepare(
          {
            operationId: parsed.data.operationId,
            input: toMessageSearchInput(parsed.data),
            targetThreadId: scope.threadId,
            ...(cloud ? { acceptedUseRef: sourceId } : {}),
            producer: {
              kind: principal.kind,
              id: principal.kind === 'invocation' ? principal.invocationId : principal.agentKeyId,
              catId: principal.catId,
            },
            principal: {
              userId: principal.userId,
              viewer: { type: 'cat', catId: principal.catId },
              publicReply: true,
              ...(sourceId ? { source: { threadId: record?.threadId ?? scope.threadId, messageId: sourceId } } : {}),
            },
          },
          {
            ...execution,
            ...(cloud
              ? {
                  authorizeAcceptedUse: async () => {
                    const grant = await deps.cloudReturnGrantStore!.claim({
                      userId: principal.userId,
                      threadId: scope.threadId,
                      sourceMessageId: sourceId!,
                      targetCatId: principal.catId,
                    });
                    if (!grant.ok) throw new MessageSearchAccessError('Exact cloud return use is not available');
                    if (!(await deps.cloudReturnGrantStore!.release(grant)))
                      throw new Error('Cloud return preparation release unconfirmed');
                  },
                }
              : {}),
          },
        ),
      reply,
    );
  });
}
