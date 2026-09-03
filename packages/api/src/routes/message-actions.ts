/**
 * Message Actions Routes
 * DELETE /api/messages/:id       — soft/hard delete (ADR-008 D3 / S5+S6)
 * PATCH  /api/messages/:id/restore — restore soft-deleted message
 */

import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import type { LegacyLocalReviewDispositionService } from '../domains/ball-custody/LegacyLocalReviewDispositionService.js';
import type { IThreadStore } from '../domains/cats/services/stores/ports/ThreadStore.js';
import { resolveDirectLocalAuthorizationUserId } from '../utils/request-identity.js';
import { type ComposerDraftRecallRoutesOptions, composerDraftRecallRoutes } from './composer-draft-recall.js';

export interface MessageActionsRoutesOptions extends ComposerDraftRecallRoutesOptions {
  threadStore?: IThreadStore;
  ownerUserId?: string;
  legacyLocalReviewDispositionService?: Pick<LegacyLocalReviewDispositionService, 'inspect' | 'settle'>;
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

const legacyLocalReviewDispositionBodySchema = z.object({
  decisionId: z.string().min(1).max(200),
  verdict: z.enum(['approved', 'changes_requested']),
});

export const messageActionsRoutes: FastifyPluginAsync<MessageActionsRoutesOptions> = async (app, opts) => {
  await app.register(composerDraftRecallRoutes, opts);

  function authorizeLegacyReviewDisposition(
    request: Parameters<typeof resolveDirectLocalAuthorizationUserId>[0],
    reply: { status(code: number): unknown },
  ): string | null {
    if (request.callbackPrincipal) {
      reply.status(403);
      return null;
    }
    const operatorUserId = resolveDirectLocalAuthorizationUserId(request);
    if (!operatorUserId) {
      reply.status(401);
      return null;
    }
    if (!opts.ownerUserId || operatorUserId !== opts.ownerUserId) {
      reply.status(403);
      return null;
    }
    return operatorUserId;
  }

  app.get<{ Params: { id: string } }>('/api/messages/:id/legacy-local-review-disposition', async (request, reply) => {
    const ownerUserId = authorizeLegacyReviewDisposition(request, reply);
    if (!ownerUserId) return { error: 'operator authorization required', code: 'CVO_AUTH_REQUIRED' };
    if (!opts.legacyLocalReviewDispositionService) {
      reply.status(503);
      return { error: 'Legacy review disposition unavailable', code: 'LEGACY_REVIEW_DISPOSITION_UNAVAILABLE' };
    }
    const inspection = await opts.legacyLocalReviewDispositionService.inspect({
      sourceMessageId: request.params.id,
      ownerUserId,
    });
    if (inspection.outcome === 'ineligible') reply.status(404);
    if (inspection.outcome === 'stale') reply.status(409);
    return inspection;
  });

  app.post<{ Params: { id: string } }>('/api/messages/:id/legacy-local-review-disposition', async (request, reply) => {
    const ownerUserId = authorizeLegacyReviewDisposition(request, reply);
    if (!ownerUserId) return { error: 'operator authorization required', code: 'CVO_AUTH_REQUIRED' };
    const parsed = legacyLocalReviewDispositionBodySchema.safeParse(request.body);
    if (!parsed.success) {
      reply.status(400);
      return { error: 'Invalid request body', details: parsed.error.issues };
    }
    if (!opts.legacyLocalReviewDispositionService) {
      reply.status(503);
      return { error: 'Legacy review disposition unavailable', code: 'LEGACY_REVIEW_DISPOSITION_UNAVAILABLE' };
    }
    const settlement = await opts.legacyLocalReviewDispositionService.settle({
      sourceMessageId: request.params.id,
      ownerUserId,
      decisionId: parsed.data.decisionId,
      verdict: parsed.data.verdict,
      now: Date.now(),
    });
    if (settlement.outcome === 'ineligible') reply.status(404);
    if (settlement.outcome === 'stale' || settlement.outcome === 'conflict') reply.status(409);
    if (settlement.outcome === 'continuation_pending') reply.status(503);
    return settlement;
  });

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

    // Merge patch into block
    const mutable = block as unknown as Record<string, unknown>;
    if (disabled !== undefined) mutable.disabled = disabled;
    if (selectedIds !== undefined) mutable.selectedIds = selectedIds;

    await opts.messageStore.updateExtra(id, msg.extra);
    return { status: 'ok' };
  });
};
