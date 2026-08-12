import type { FastifyPluginAsync } from 'fastify';
import type { InvocationQueue } from '../domains/cats/services/agents/invocation/InvocationQueue.js';
import type { QueuedMessageCustodyCoordinator } from '../domains/cats/services/agents/invocation/QueuedMessageCustodyCoordinator.js';
import type { QueueProcessor } from '../domains/cats/services/agents/invocation/QueueProcessor.js';
import type { IMessageStore } from '../domains/cats/services/stores/ports/MessageStore.js';
import type { IThreadStore } from '../domains/cats/services/stores/ports/ThreadStore.js';
import type { IIndexBuilder } from '../domains/memory/interfaces.js';
import type { SocketManager } from '../infrastructure/websocket/index.js';
import { resolveStrictUserId } from '../utils/request-identity.js';
import { createRecallMessageHandler } from './composer-draft-recall-handler.js';
import { composerDraftClearSchema, composerDraftPutSchema, recallBodySchema } from './composer-draft-recall-helpers.js';

export interface ComposerDraftRecallRoutesOptions {
  messageStore: IMessageStore;
  threadStore?: Pick<IThreadStore, 'get' | 'compareAndSetTitle'>;
  socketManager: SocketManager;
  invocationQueue?: InvocationQueue;
  queueCustodyCoordinator?: Pick<QueuedMessageCustodyCoordinator, 'recallMessageToComposerDraft'>;
  queueProcessor?: Pick<QueueProcessor, 'unregisterEntryCompleteHook' | 'finalizeRemovedEntry'>;
  indexBuilder?: Pick<
    IIndexBuilder,
    'suppressMessagePassage' | 'releaseMessagePassageSuppression' | 'finalizeMessagePassageSuppression'
  >;
}

export const composerDraftRecallRoutes: FastifyPluginAsync<ComposerDraftRecallRoutesOptions> = async (app, opts) => {
  const requireStrictOwner = (
    request: Parameters<typeof resolveStrictUserId>[0],
    reply: { status(code: number): unknown },
  ) => {
    const ownerUserId = resolveStrictUserId(request);
    if (ownerUserId) return ownerUserId;
    reply.status(401);
    return null;
  };

  app.get<{ Params: { threadId: string } }>('/api/threads/:threadId/composer-draft', async (request, reply) => {
    const ownerUserId = requireStrictOwner(request, reply);
    if (!ownerUserId) return { error: 'Authentication required', code: 'AUTH_REQUIRED' };
    const draft = await opts.messageStore.getOwnerComposerDraft(ownerUserId, request.params.threadId);
    return { draft, revision: draft?.revision ?? 0 };
  });

  app.put<{ Params: { threadId: string } }>('/api/threads/:threadId/composer-draft', async (request, reply) => {
    const ownerUserId = requireStrictOwner(request, reply);
    if (!ownerUserId) return { error: 'Authentication required', code: 'AUTH_REQUIRED' };
    const parsed = composerDraftPutSchema.safeParse(request.body);
    if (!parsed.success) {
      reply.status(400);
      return { error: 'Invalid request body', details: parsed.error.issues };
    }
    const result = await opts.messageStore.putOwnerComposerDraft(ownerUserId, request.params.threadId, {
      ...parsed.data,
      updatedAt: Date.now(),
    });
    if (result.kind === 'revision_mismatch') {
      reply.status(409);
      return { code: 'DRAFT_REVISION_MISMATCH', actualRevision: result.actualRevision };
    }
    return { draft: result.draft };
  });

  app.delete<{ Params: { threadId: string } }>('/api/threads/:threadId/composer-draft', async (request, reply) => {
    const ownerUserId = requireStrictOwner(request, reply);
    if (!ownerUserId) return { error: 'Authentication required', code: 'AUTH_REQUIRED' };
    const parsed = composerDraftClearSchema.safeParse(request.body);
    if (!parsed.success) {
      reply.status(400);
      return { error: 'Invalid request body', details: parsed.error.issues };
    }
    const result = await opts.messageStore.clearOwnerComposerDraft(
      ownerUserId,
      request.params.threadId,
      parsed.data.expectedRevision,
      Date.now(),
    );
    if (result.kind === 'revision_mismatch') {
      reply.status(409);
      return { code: 'DRAFT_REVISION_MISMATCH', actualRevision: result.actualRevision };
    }
    return { cleared: true, revision: result.revision };
  });

  if (opts.invocationQueue && opts.queueCustodyCoordinator && opts.indexBuilder && opts.threadStore) {
    app.post<{ Params: { id: string } }>(
      '/api/messages/:id/recall',
      createRecallMessageHandler(
        {
          ...opts,
          invocationQueue: opts.invocationQueue,
          queueCustodyCoordinator: opts.queueCustodyCoordinator,
          indexBuilder: opts.indexBuilder,
          threadStore: opts.threadStore,
        },
        requireStrictOwner,
      ),
    );
  } else {
    app.post('/api/messages/:id/recall', async (request, reply) => {
      const ownerUserId = requireStrictOwner(request, reply);
      if (!ownerUserId) return { error: 'Authentication required', code: 'AUTH_REQUIRED' };
      const parsed = recallBodySchema.safeParse(request.body);
      if (!parsed.success) {
        reply.status(400);
        return { error: 'Invalid request body', details: parsed.error.issues };
      }
      reply.status(503);
      return { error: 'True recall is unavailable', code: 'TRUE_RECALL_UNAVAILABLE' };
    });
  }
};
