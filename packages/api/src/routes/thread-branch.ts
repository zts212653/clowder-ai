/**
 * Thread Branch Route
 * POST /api/threads/:id/branch — create conversation branch (ADR-008 D4 / S7)
 *
 * Edit = Branch: editing a message creates a new thread with history
 * up to that message, replacing the last message with edited content.
 */

import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import type { IMessageStore } from '../domains/cats/services/stores/ports/MessageStore.js';
import type { IThreadStore } from '../domains/cats/services/stores/ports/ThreadStore.js';
import type { SocketManager } from '../infrastructure/websocket/index.js';

export interface ThreadBranchRoutesOptions {
  threadStore: IThreadStore;
  messageStore: IMessageStore;
  socketManager: SocketManager;
}

const DEFAULT_ROLLBACK_RETRY_DELAYS_MS = [1000, 3000, 10000];

interface RollbackCleanupResult {
  messageCleanup: PromiseSettledResult<number>;
  threadCleanup: PromiseSettledResult<boolean>;
}

function readRollbackRetryDelays(): number[] {
  const raw = process.env.CAT_BRANCH_ROLLBACK_RETRY_DELAYS_MS;
  if (!raw) return DEFAULT_ROLLBACK_RETRY_DELAYS_MS;
  const parsed = raw
    .split(',')
    .map((part) => Number(part.trim()))
    .filter((num) => Number.isFinite(num) && num >= 0);
  return parsed.length > 0 ? parsed : DEFAULT_ROLLBACK_RETRY_DELAYS_MS;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function attemptRollbackCleanup(
  threadId: string,
  messageStore: IMessageStore,
  threadStore: IThreadStore,
): Promise<RollbackCleanupResult> {
  const messageCleanupPromise = Promise.resolve().then(() => messageStore.deleteByThread(threadId));
  const threadCleanupPromise = Promise.resolve().then(() => threadStore.delete(threadId));
  const [messageCleanup, threadCleanup] = await Promise.allSettled([messageCleanupPromise, threadCleanupPromise]);
  return { messageCleanup, threadCleanup };
}

function rollbackCleanupDone(result: RollbackCleanupResult): boolean {
  return result.messageCleanup.status === 'fulfilled' && result.threadCleanup.status === 'fulfilled';
}

function scheduleRollbackReconcile(
  threadId: string,
  messageStore: IMessageStore,
  threadStore: IThreadStore,
  log: {
    warn: (obj: unknown, msg?: string) => void;
    error: (obj: unknown, msg?: string) => void;
    info: (obj: unknown, msg?: string) => void;
  },
): void {
  const retryDelays = readRollbackRetryDelays();
  if (retryDelays.length === 0) return;

  void (async () => {
    try {
      for (let attempt = 0; attempt < retryDelays.length; attempt++) {
        const delay = retryDelays[attempt]!;
        if (delay > 0) {
          await sleep(delay);
        }
        const result = await attemptRollbackCleanup(threadId, messageStore, threadStore);
        if (rollbackCleanupDone(result)) {
          log.info({ branchThreadId: threadId, attempt: attempt + 1 }, 'Branch orphan reconciled');
          return;
        }
        log.warn(
          {
            branchThreadId: threadId,
            attempt: attempt + 1,
            messageCleanup: result.messageCleanup.status,
            threadCleanup: result.threadCleanup.status,
          },
          'Branch orphan reconcile retry failed',
        );
      }
      log.error({ branchThreadId: threadId, retries: retryDelays.length }, 'Branch orphan reconcile exhausted retries');
    } catch (err) {
      // Reconcile path is best-effort; never let background logging failures surface as unhandled rejection.
      try {
        log.error({ err, branchThreadId: threadId }, 'Branch orphan reconcile crashed');
      } catch {
        // Swallow: logger itself can fail (serialization failures, transport errors).
      }
    }
  })();
}

const branchSchema = z.object({
  fromMessageId: z.string().min(1),
  editedContent: z.string().optional(),
  userId: z.string().min(1).max(100),
});

export const threadBranchRoutes: FastifyPluginAsync<ThreadBranchRoutesOptions> = async (app, opts) => {
  const { threadStore, messageStore, socketManager } = opts;

  // POST /api/threads/:id/branch — create branch from a message
  app.post<{ Params: { id: string } }>('/api/threads/:id/branch', async (request, reply) => {
    const { id } = request.params;
    const parseResult = branchSchema.safeParse(request.body);
    if (!parseResult.success) {
      reply.status(400);
      return { error: 'Invalid request body', details: parseResult.error.issues };
    }

    const { fromMessageId, editedContent, userId } = parseResult.data;

    // ① Verify source thread exists and caller has access
    const sourceThread = await threadStore.get(id);
    if (!sourceThread) {
      reply.status(404);
      return { error: '对话不存在', code: 'THREAD_NOT_FOUND' };
    }
    if (sourceThread.createdBy !== userId && sourceThread.createdBy !== 'system') {
      reply.status(403);
      return { error: '无权对此对话创建分支', code: 'UNAUTHORIZED' };
    }

    // ② Verify fromMessage exists and belongs to this thread
    const fromMessage = await messageStore.getById(fromMessageId);
    if (!fromMessage || fromMessage.threadId !== id) {
      reply.status(400);
      return { error: '指定的消息不存在或不属于此对话', code: 'INVALID_FROM_MESSAGE' };
    }

    // ③ Get all visible messages up to and including fromMessage
    // getByThread filters soft-deleted/tombstone — cannot branch from deleted messages
    const allMessages = await messageStore.getByThread(id, 10000);
    const cutIndex = allMessages.findIndex((m) => m.id === fromMessageId);
    if (cutIndex === -1) {
      reply.status(400);
      return { error: '无法从已删除的消息创建分支', code: 'FROM_MESSAGE_DELETED' };
    }
    const messagesToCopy = allMessages.slice(0, cutIndex + 1);

    // ④ Create new thread with "(分支)" suffix
    const branchTitle = sourceThread.title ? `${sourceThread.title} (分支)` : '分支对话';
    const newThread = await threadStore.create(userId, branchTitle, sourceThread.projectPath);

    // ⑤ Copy participants + messages inside guarded block; rollback on any failure
    try {
      if (sourceThread.participants.length > 0) {
        await threadStore.addParticipants(newThread.id, sourceThread.participants);
      }

      for (let i = 0; i < messagesToCopy.length; i++) {
        const src = messagesToCopy[i]!;
        const isLast = i === messagesToCopy.length - 1;
        const content = isLast && editedContent !== undefined ? editedContent : src.content;

        await messageStore.append({
          userId: src.userId,
          catId: src.catId,
          content,
          ...(src.contentBlocks && !(isLast && editedContent !== undefined)
            ? { contentBlocks: src.contentBlocks }
            : {}),
          ...(src.metadata ? { metadata: src.metadata } : {}),
          ...(src.origin ? { origin: src.origin } : {}),
          mentions: [...src.mentions],
          timestamp: src.timestamp,
          threadId: newThread.id,
        });
      }
    } catch (err) {
      // Best-effort cleanup: sync/async failure-safe
      const cleanup = await attemptRollbackCleanup(newThread.id, messageStore, threadStore);
      if (!rollbackCleanupDone(cleanup)) {
        scheduleRollbackReconcile(newThread.id, messageStore, threadStore, request.log);
      }
      request.log.error(
        {
          err,
          branchThreadId: newThread.id,
          messageCleanup: cleanup.messageCleanup.status,
          threadCleanup: cleanup.threadCleanup.status,
        },
        'Branch copy failed, rolled back',
      );
      reply.status(500);
      return { error: '分支创建失败，已回滚', code: 'BRANCH_FAILED' };
    }

    // Notify frontend about new branch
    socketManager.broadcastToRoom(`thread:${id}`, 'thread_branched', {
      sourceThreadId: id,
      newThreadId: newThread.id,
      fromMessageId,
    });

    reply.status(201);
    return {
      threadId: newThread.id,
      messageCount: messagesToCopy.length,
      title: branchTitle,
    };
  });
};
