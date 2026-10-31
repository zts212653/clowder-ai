import type { CatId } from '@cat-cafe/shared';
import type { FastifyInstance } from 'fastify';
import {
  freshnessMessageFilter,
  isFreshnessCandidate,
} from '../domains/cats/services/freshness/freshness-candidate.js';
import { cursorFor } from '../domains/cats/services/stores/cursor.js';
import { messageFrom } from '../domains/cats/services/stores/message-from.js';
import type { IMessageStore } from '../domains/cats/services/stores/ports/MessageStore.js';
import { resolveStrictUserId } from '../utils/request-identity.js';

/** No seen cursor is read or advanced: these rows carry no per-response read receipt. */
export function registerGenerationMessagesRoute(app: FastifyInstance, messageStore: IMessageStore) {
  app.get<{ Params: { threadId: string; messageId: string } }>(
    '/api/threads/:threadId/messages/:messageId/generation-messages',
    async (request, reply) => {
      const userId = resolveStrictUserId(request);
      if (!userId) return reply.code(401).send({ error: 'Identity required' });
      const { threadId, messageId } = request.params;
      const response = await messageStore.getById(messageId);
      if (!response || response.userId !== userId || response.threadId !== threadId || response.deletedAt)
        return reply.code(404).send({ error: 'Message not found' });
      const lifecycle = response.lifecycle;
      const empty = { messageIds: [] as string[], hasAppendedInputs: false, complete: true };
      if (lifecycle?.kind !== 'response') return empty;
      const end = lifecycle.status === 'processing' ? Date.now() : lifecycle.completedAt;
      if (!Number.isFinite(lifecycle.startedAt) || end === undefined || !Number.isFinite(end)) return empty;
      const initial = await messageStore.getById(lifecycle.inputMessageIds[0] ?? '');
      if (!initial || initial.threadId !== threadId || initial.visibilitySeq === undefined) return empty;
      const inputIds = new Set(lifecycle.inputMessageIds);
      const messageIds: string[] = [];
      const context = {
        catId: lifecycle.targetId,
        threadId,
        messageStore,
        // Historical labels must never count whispers addressed only to another cat.
        messageFilter: freshnessMessageFilter(lifecycle.targetId as CatId, true),
      };
      let cursor = cursorFor(initial);
      let hasAppendedInputs = false;
      for (let page = 0; page < 100; page++) {
        const batch = await messageStore.getByThreadAfter(threadId, cursor, 200, userId, {
          unresolvedCursorPolicy: 'empty',
        });
        for (const message of batch) {
          // Cat speech is published when authored; queued human work only at delivery.
          // visibilitySeq is an ordering token, not a wall-clock timestamp.
          const publishedAt =
            messageFrom(message).kind === 'agent' ? message.timestamp : (message.deliveredAt ?? message.timestamp);
          if (publishedAt < lifecycle.startedAt || publishedAt > end) continue;
          if (inputIds.has(message.id)) {
            if (message.id !== initial.id) hasAppendedInputs = true;
            continue;
          }
          if (await isFreshnessCandidate(message, context)) messageIds.push(message.id);
        }
        if (batch.length < 200) return { messageIds, hasAppendedInputs, complete: true };
        cursor = cursorFor(batch[batch.length - 1]!);
      }
      // Never present a truncated scan as an exact count.
      return { ...empty, complete: false };
    },
  );
}
