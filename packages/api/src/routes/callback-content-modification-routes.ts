import { inspectContentModificationSchema, respondContentTextSchema } from '@cat-cafe/shared';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { IThreadStore } from '../domains/cats/services/stores/ports/ThreadStore.js';
import { inspectContentModification } from '../domains/collaborative-content/modification/inspection.js';
import type { ContentModificationService } from '../domains/collaborative-content/modification/service.js';
import type { ModificationSourceDiscussions } from '../domains/collaborative-content/modification/source-discussions.js';
import type { ContentTextModificationService } from '../domains/collaborative-content/modification/text/text-service.js';
import {
  type AgentKeyAuthRegistry,
  type CallbackAuthRegistry,
  registerCallbackAuthHook,
  requireCallbackPrincipal,
} from './callback-auth-prehandler.js';
import { resolvePrincipalThread } from './callback-scope-helpers.js';
import { replyContentModificationError } from './content-modification-routes.js';

export async function registerCallbackContentModificationRoutes(
  app: FastifyInstance,
  deps: {
    text: ContentTextModificationService;
    requests?: Pick<ContentModificationService, 'controlForCat'>;
    sourceDiscussions?: Pick<ModificationSourceDiscussions, 'forRequest'>;
    threads: Pick<IThreadStore, 'get' | 'list'>;
    registry: CallbackAuthRegistry;
    agentKeyRegistry?: AgentKeyAuthRegistry;
    changed: (userId: string, requestId: string) => void;
  },
) {
  for (const operation of ['read', 'respond'] as const)
    await app.register(async (scope) => {
      registerCallbackAuthHook(scope, deps.registry, {
        ...(deps.agentKeyRegistry ? { agentKeyRegistry: deps.agentKeyRegistry } : {}),
        ...(operation === 'read' ? { enforceToolExecutionPolicy: false } : {}),
      });
      scope.post(
        `/api/callbacks/content-modification/${operation}`,
        { bodyLimit: 5 * 1024 * 1024 },
        async (request, reply) => {
          reply.header('Cache-Control', 'private, no-store');
          const auth = requireCallbackPrincipal(request, reply);
          if (!auth) return;
          try {
            const schema = operation === 'read' ? inspectContentModificationSchema : respondContentTextSchema;
            const { threadId, ...input } = schema
              .extend({ threadId: z.string().min(1).max(128).optional() })
              .parse(request.body);
            const thread = await resolvePrincipalThread(auth, threadId, { threadStore: deps.threads });
            if (!thread.ok) return reply.code(thread.statusCode).send({ error: thread.error });
            const principal = {
              userId: auth.userId,
              threadId: thread.threadId,
              actor: { kind: 'cat' as const, actorId: auth.catId },
            };
            if (operation === 'read')
              return await inspectContentModification(
                deps.text,
                input,
                principal,
                deps.sourceDiscussions,
                deps.requests,
              );
            const result = await deps.text.respond(input, principal);
            deps.changed(auth.userId, result.proposal.requestId);
            return {
              proposalRef: result.proposal.proposalRef,
              revision: result.proposal.revision,
              receiptRef: result.proposal.receiptRef,
              baseRevision: result.proposal.baseRevision,
              resultRevision: result.proposal.resultRevision,
              candidatePath: result.candidatePath,
              state: 'awaiting_human_acceptance',
            };
          } catch (error) {
            return replyContentModificationError(reply, error);
          }
        },
      );
    });
}
