/**
 * F128: Cat-Initiated Thread Creation Callback Route
 * POST /api/callbacks/create-thread
 */

import type { CatId } from '@cat-cafe/shared';
import { catIdSchema } from '@cat-cafe/shared';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { InvocationRegistry } from '../domains/cats/services/agents/invocation/InvocationRegistry.js';
import type { IThreadStore } from '../domains/cats/services/stores/ports/ThreadStore.js';
import type { SocketManager } from '../infrastructure/websocket/index.js';
import { callbackAuthSchema } from './callback-auth-schema.js';
import { EXPIRED_CREDENTIALS_ERROR } from './callback-errors.js';

const createThreadCallbackSchema = callbackAuthSchema.extend({
  title: z.string().trim().min(1).max(200),
  preferredCats: z.array(catIdSchema()).max(10).optional(),
  parentThreadId: z.string().min(1).optional(),
});

export function registerCallbackCreateThreadRoutes(
  app: FastifyInstance,
  deps: { registry: InvocationRegistry; threadStore: IThreadStore; socketManager: SocketManager },
): void {
  const { registry, threadStore, socketManager } = deps;

  app.post('/api/callbacks/create-thread', async (request, reply) => {
    const parsed = createThreadCallbackSchema.safeParse(request.body);
    if (!parsed.success) {
      reply.status(400);
      return { error: 'Invalid request body', details: parsed.error.issues };
    }

    const { invocationId, callbackToken, title, preferredCats, parentThreadId } = parsed.data;
    const record = registry.verify(invocationId, callbackToken);
    if (!record) {
      reply.status(401);
      return EXPIRED_CREDENTIALS_ERROR;
    }

    // P2: Stale invocation guard — reject if superseded by newer invocation
    if (!registry.isLatest(invocationId)) {
      return { status: 'stale_ignored' };
    }

    // P2: Inherit projectPath from the invoking thread so the new thread
    // lands in the correct project context (avoids "default" fallback).
    const sourceThread = await threadStore.get(record.threadId);
    const projectPath = sourceThread?.projectPath;

    // F128: Auto-set parentThreadId to the invoking thread if not explicitly provided.
    // Cats don't know their own threadId as a string, so the server infers it.
    const effectiveParentThreadId = parentThreadId ?? record.threadId;

    const thread = await threadStore.create(record.userId, title, projectPath, effectiveParentThreadId);

    if (preferredCats && preferredCats.length > 0) {
      await threadStore.updatePreferredCats(thread.id, preferredCats as CatId[]);
    }

    // Notify frontend sidebar so new thread appears without manual refresh
    const fullThread = await threadStore.get(thread.id);
    if (fullThread) {
      socketManager.emitToUser(record.userId, 'thread_created', fullThread);
    }

    reply.status(201);
    return { threadId: thread.id, parentThreadId: effectiveParentThreadId };
  });
}
