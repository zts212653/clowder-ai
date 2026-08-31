import type { ThreadProgressSourceRef } from '@cat-cafe/shared';
import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import type { IMessageStore } from '../domains/cats/services/stores/ports/MessageStore.js';
import type { ITaskStore } from '../domains/cats/services/stores/ports/TaskStore.js';
import type { IThreadStore, Thread } from '../domains/cats/services/stores/ports/ThreadStore.js';
import type { ThreadBriefAssembler } from '../domains/thread-progress/ThreadBriefAssembler.js';
import type { ThreadBriefCollectionAssembler } from '../domains/thread-progress/ThreadBriefCollectionAssembler.js';
import {
  InvalidThreadProgressCursorError,
  type IThreadProgressReceiptStore,
} from '../domains/thread-progress/ThreadProgressReceiptStore.js';
import { resolveUserId } from '../utils/request-identity.js';

export interface ThreadProgressRoutesOptions {
  readonly threadStore: Pick<IThreadStore, 'get'>;
  readonly receiptStore: IThreadProgressReceiptStore;
  readonly assembler: ThreadBriefAssembler;
  readonly collectionAssembler: ThreadBriefCollectionAssembler;
  readonly messageStore: Pick<IMessageStore, 'getById'>;
  readonly taskStore: Pick<ITaskStore, 'get'>;
}

const progressQuerySchema = z.object({
  cursor: z.string().min(1).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});

const recentBriefsQuerySchema = z.object({
  scope: z.literal('recent'),
  cursor: z.string().min(1).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});

async function requireOwnedConversation(
  request: Parameters<typeof resolveUserId>[0],
  reply: { status(code: number): unknown },
  threadStore: Pick<IThreadStore, 'get'>,
  threadId: string,
): Promise<{ thread: Thread; userId: string } | null> {
  const userId = resolveUserId(request);
  if (!userId) {
    reply.status(401);
    return null;
  }
  const thread = await threadStore.get(threadId);
  if (!thread) {
    reply.status(404);
    return null;
  }
  if (thread.createdBy !== userId || thread.deletedAt || thread.systemKind || thread.threadKind) {
    reply.status(403);
    return null;
  }
  return { thread, userId };
}

export const threadProgressRoutes: FastifyPluginAsync<ThreadProgressRoutesOptions> = async (app, opts) => {
  app.get('/api/threads/briefs', async (request, reply) => {
    const userId = resolveUserId(request);
    if (!userId) {
      reply.status(401);
      return { error: 'Thread progress unavailable' };
    }
    const parsed = recentBriefsQuerySchema.safeParse(request.query);
    if (!parsed.success) {
      reply.status(400);
      return { error: 'Invalid recent threads query' };
    }
    try {
      return await opts.collectionAssembler.assemble(userId, parsed.data);
    } catch (error) {
      if (error instanceof InvalidThreadProgressCursorError) {
        reply.status(400);
        return { error: 'Invalid recent thread cursor' };
      }
      request.log.warn({ err: error, feature: 'F308' }, 'F308 recent thread briefs unavailable');
      reply.status(503);
      return { error: 'Thread progress unavailable' };
    }
  });

  app.get<{ Params: { threadId: string } }>('/api/threads/:threadId/brief', async (request, reply) => {
    const access = await requireOwnedConversation(request, reply, opts.threadStore, request.params.threadId);
    if (!access) return { error: 'Thread progress unavailable' };
    return opts.assembler.assemble(access.thread, access.userId);
  });

  app.get<{ Params: { threadId: string } }>('/api/threads/:threadId/progress', async (request, reply) => {
    const access = await requireOwnedConversation(request, reply, opts.threadStore, request.params.threadId);
    if (!access) return { error: 'Thread progress unavailable' };
    const parsed = progressQuerySchema.safeParse(request.query);
    if (!parsed.success) {
      reply.status(400);
      return { error: 'Invalid progress cursor' };
    }
    return opts.receiptStore.listPageByThread(access.userId, access.thread.id, parsed.data);
  });

  app.get<{
    Params: { threadId: string; receiptId: string; sourceIndex: string };
  }>('/api/threads/:threadId/progress/:receiptId/sources/:sourceIndex', async (request, reply) => {
    const access = await requireOwnedConversation(request, reply, opts.threadStore, request.params.threadId);
    if (!access) return { error: 'Thread progress unavailable' };
    const receipt = await opts.receiptStore.get(request.params.receiptId);
    if (!receipt || receipt.ownerUserId !== access.userId || receipt.threadId !== access.thread.id) {
      reply.status(404);
      return { error: 'Progress source not found' };
    }
    const sourceIndex = Number(request.params.sourceIndex);
    const source = Number.isInteger(sourceIndex) ? receipt.provenance[sourceIndex] : undefined;
    if (!source) {
      reply.status(404);
      return { error: 'Progress source not found' };
    }
    const resolved = await resolveProgressSource(source, access, opts);
    if (!resolved) {
      reply.status(404);
      return { error: 'Progress source not found' };
    }
    return resolved;
  });
};

async function resolveProgressSource(
  source: ThreadProgressSourceRef,
  access: { thread: Thread; userId: string },
  opts: ThreadProgressRoutesOptions,
): Promise<
  | { kind: 'invocation'; available: false }
  | { kind: 'message'; threadId: string; messageId: string }
  | { kind: 'task'; threadId: string; taskId: string }
  | null
> {
  if (source.kind === 'invocation') return { kind: 'invocation', available: false };
  if (source.kind === 'message') {
    const message = await opts.messageStore.getById(source.messageId);
    return message?.userId === access.userId && message.threadId === access.thread.id
      ? { kind: 'message', threadId: access.thread.id, messageId: message.id }
      : null;
  }
  const task = await opts.taskStore.get(source.taskId);
  return task && task.threadId === access.thread.id && (!task.userId || task.userId === access.userId)
    ? { kind: 'task', threadId: access.thread.id, taskId: task.id }
    : null;
}
