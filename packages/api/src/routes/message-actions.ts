/**
 * Message Actions Routes
 * DELETE /api/messages/:id       — soft/hard delete (ADR-008 D3 / S5+S6)
 * PATCH  /api/messages/:id/restore — restore soft-deleted message
 */

import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import type { IMessageStore } from '../domains/cats/services/stores/ports/MessageStore.js';
import type { IThreadStore } from '../domains/cats/services/stores/ports/ThreadStore.js';
import type { SocketManager } from '../infrastructure/websocket/index.js';

export interface MessageActionsRoutesOptions {
  messageStore: IMessageStore;
  socketManager: SocketManager;
  threadStore?: IThreadStore;
  /** AC-D6: Activity bus for leadership event emission */
  activityBus?: import('../domains/activity/ActivityEventBus.js').ActivityEventBus;
}

const deleteBodySchema = z.object({
  userId: z.string().min(1).max(100),
  mode: z.enum(['soft', 'hard']).default('soft'),
  /** Required for hard delete — must match thread title as confirmation */
  confirmTitle: z.string().optional(),
});

const restoreBodySchema = z.object({
  userId: z.string().min(1).max(100),
});

export const messageActionsRoutes: FastifyPluginAsync<MessageActionsRoutesOptions> = async (app, opts) => {
  // DELETE /api/messages/:id — soft or hard delete a single message
  app.delete<{ Params: { id: string } }>('/api/messages/:id', async (request, reply) => {
    const parseResult = deleteBodySchema.safeParse(request.body);
    if (!parseResult.success) {
      reply.status(400);
      return { error: 'Invalid request body', details: parseResult.error.issues };
    }

    const { id } = request.params;
    const { userId, mode, confirmTitle } = parseResult.data;

    // Authorization: verify message exists and caller owns it or is thread creator
    const targetMsg = await opts.messageStore.getById(id);
    if (!targetMsg) {
      reply.status(404);
      return { error: '消息不存在', code: 'MESSAGE_NOT_FOUND' };
    }
    if (targetMsg.userId !== userId) {
      // Not the message author — check if thread creator
      if (opts.threadStore) {
        const thread = await opts.threadStore.get(targetMsg.threadId);
        if (!thread || thread.createdBy !== userId) {
          reply.status(403);
          return { error: '无权删除此消息', code: 'UNAUTHORIZED' };
        }
      } else {
        reply.status(403);
        return { error: '无权删除此消息', code: 'UNAUTHORIZED' };
      }
    }

    if (mode === 'hard') {
      // Hard delete requires confirmTitle matching the thread title
      if (!confirmTitle) {
        reply.status(400);
        return { error: '硬删除需要输入对话标题确认', code: 'CONFIRM_TITLE_REQUIRED' };
      }

      if (opts.threadStore) {
        const thread = await opts.threadStore.get(targetMsg.threadId);
        // Untitled threads require fixed confirmation phrase
        const expectedTitle = thread?.title ?? '确认删除';
        if (confirmTitle !== expectedTitle) {
          reply.status(400);
          return { error: '对话标题不匹配', code: 'CONFIRM_TITLE_MISMATCH' };
        }
      }

      const deleted = await opts.messageStore.hardDelete(id, userId);
      if (!deleted) {
        reply.status(500);
        return { error: '删除失败', code: 'DELETE_FAILED' };
      }

      opts.socketManager.broadcastToRoom(`thread:${deleted.threadId}`, 'message_hard_deleted', {
        messageId: id,
        threadId: deleted.threadId,
        deletedBy: userId,
      });

      return {
        id: deleted.id,
        threadId: deleted.threadId,
        deletedAt: deleted.deletedAt,
        deletedBy: deleted.deletedBy,
        _tombstone: true,
      };
    }

    // Soft delete (default)
    const deleted = await opts.messageStore.softDelete(id, userId);
    if (!deleted) {
      reply.status(404);
      return { error: '消息不存在', code: 'MESSAGE_NOT_FOUND' };
    }

    opts.socketManager.broadcastToRoom(`thread:${deleted.threadId}`, 'message_deleted', {
      messageId: id,
      threadId: deleted.threadId,
      deletedBy: userId,
    });

    return {
      id: deleted.id,
      threadId: deleted.threadId,
      deletedAt: deleted.deletedAt,
      deletedBy: deleted.deletedBy,
    };
  });

  // PATCH /api/messages/:id/restore — restore a soft-deleted message (rejects tombstones)
  app.patch<{ Params: { id: string } }>('/api/messages/:id/restore', async (request, reply) => {
    const parseResult = restoreBodySchema.safeParse(request.body);
    if (!parseResult.success) {
      reply.status(400);
      return { error: 'Invalid request body', details: parseResult.error.issues };
    }

    const { id } = request.params;
    const { userId } = parseResult.data;

    // Pre-fetch message to check authorization
    const targetMsg = await opts.messageStore.getById(id);
    if (!targetMsg) {
      reply.status(404);
      return { error: '消息不存在', code: 'MESSAGE_NOT_FOUND' };
    }
    if (!targetMsg.deletedAt || targetMsg._tombstone) {
      reply.status(404);
      return { error: '消息不存在、未被删除、或已硬删除', code: 'MESSAGE_NOT_RESTORABLE' };
    }

    // Authorization: only the person who deleted can restore, or thread creator
    if (targetMsg.deletedBy !== userId) {
      if (opts.threadStore) {
        const thread = await opts.threadStore.get(targetMsg.threadId);
        if (!thread || thread.createdBy !== userId) {
          reply.status(403);
          return { error: '无权恢复此消息', code: 'UNAUTHORIZED' };
        }
      } else {
        reply.status(403);
        return { error: '无权恢复此消息', code: 'UNAUTHORIZED' };
      }
    }

    const restored = await opts.messageStore.restore(id);
    if (!restored) {
      reply.status(500);
      return { error: '恢复失败', code: 'RESTORE_FAILED' };
    }

    opts.socketManager.broadcastToRoom(`thread:${restored.threadId}`, 'message_restored', {
      messageId: id,
      threadId: restored.threadId,
    });

    return {
      id: restored.id,
      threadId: restored.threadId,
      content: restored.content,
      timestamp: restored.timestamp,
    };
  });

  // F096: PATCH /api/messages/:id/block-state — persist interactive block state
  const patchBlockStateSchema = z.object({
    userId: z.string().min(1).max(100),
    blockId: z.string().min(1),
    disabled: z.boolean().optional(),
    selectedIds: z.array(z.string()).optional(),
  });

  app.patch<{ Params: { id: string } }>('/api/messages/:id/block-state', async (request, reply) => {
    const parsed = patchBlockStateSchema.safeParse(request.body);
    if (!parsed.success) {
      reply.status(400);
      return { error: 'Invalid request', details: parsed.error.issues };
    }

    const { id } = request.params;
    const { userId, blockId, disabled, selectedIds } = parsed.data;
    const msg = await opts.messageStore.getById(id);
    if (!msg) {
      reply.status(404);
      return { error: 'Message not found' };
    }

    // P1-1 fix: Authorization — caller must own message or be thread creator
    if (msg.userId !== userId) {
      if (opts.threadStore) {
        const thread = await opts.threadStore.get(msg.threadId);
        if (!thread || thread.createdBy !== userId) {
          reply.status(403);
          return { error: 'Unauthorized', code: 'UNAUTHORIZED' };
        }
      } else {
        reply.status(403);
        return { error: 'Unauthorized', code: 'UNAUTHORIZED' };
      }
    }

    if (!msg.extra?.rich?.blocks) {
      reply.status(404);
      return { error: 'Message has no rich blocks' };
    }

    const block = msg.extra.rich.blocks.find((b) => b.id === blockId);
    if (!block) {
      reply.status(404);
      return { error: `Block ${blockId} not found` };
    }

    // P2-2 fix: only allow patching interactive blocks
    if (block.kind !== 'interactive') {
      reply.status(400);
      return { error: `Block ${blockId} is not interactive (kind: ${block.kind})` };
    }

    // P2-3: Capture old state before mutation for idempotency check
    const interactiveBlock = block as {
      interactiveType?: string;
      options?: Array<{ id: string }>;
      selectedIds?: string[];
    };
    const oldSelectedIds = interactiveBlock.selectedIds;

    // Merge patch into block
    const mutable = block as unknown as Record<string, unknown>;
    if (disabled !== undefined) mutable.disabled = disabled;
    if (selectedIds !== undefined) mutable.selectedIds = selectedIds;

    await opts.messageStore.updateExtra(id, msg.extra);

    // AC-D6: Only 'confirm'-type interactive blocks count as leadership decisions.
    if (selectedIds?.length && interactiveBlock.interactiveType === 'confirm' && opts.activityBus) {
      // P2-3: Validate selectedIds against block.options
      const validOptionIds = new Set((interactiveBlock.options ?? []).map((o) => o.id));
      const validatedIds = selectedIds.filter((sid) => validOptionIds.has(sid));
      // P2-3: Idempotency — skip if no valid options or selectedIds unchanged
      const oldSet = new Set(oldSelectedIds ?? []);
      const isChanged =
        validatedIds.length > 0 &&
        (validatedIds.length !== oldSet.size || validatedIds.some((sid) => !oldSet.has(sid)));
      if (isChanged) {
        opts.activityBus.record('decision_confirmed', 'co-creator', {
          source: 'explicit',
          confidence: 1.0,
          blockId,
          messageId: id,
          threadId: msg.threadId,
        });
      }
    }

    return { status: 'ok' };
  });
};
