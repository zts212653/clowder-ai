import { z } from 'zod';
import type { MessageEvidenceProjection } from '../../stores/message-evidence-projection.js';
import type { IThreadStore } from '../../stores/ports/ThreadStore.js';

const messageRequest = z.tuple([z.string().min(1).max(200), z.number().int().min(1).max(2000)]);

/** Composes the existing source projections under the deployment's index owner. */
export function createMemoryIndexSources(input: {
  messageStore: {
    getThreadEvidenceProjection(
      threadId: string,
      limit: number,
      userId: string,
    ): MessageEvidenceProjection[] | Promise<MessageEvidenceProjection[]>;
  };
  threadStore: Pick<IThreadStore, 'get' | 'list'>;
  ownerUserId: string;
  assertActivation?(): void;
}) {
  return {
    async listThreads() {
      input.assertActivation?.();
      const threads = await input.threadStore.list(input.ownerUserId);
      input.assertActivation?.();
      return threads
        .filter((thread) => !thread.projectPath.startsWith('games/'))
        .map((thread) => ({
          id: thread.id,
          title: thread.title,
          participants: thread.participants.map(String),
          threadMemory: thread.threadMemory ? { summary: thread.threadMemory.summary } : null,
          lastActiveAt: thread.lastActiveAt,
          featureIds: thread.backlogItemId ? [thread.backlogItemId] : undefined,
        }));
    },
    async listExcludedThreadIds() {
      input.assertActivation?.();
      const threads = await input.threadStore.list(input.ownerUserId);
      input.assertActivation?.();
      return threads.filter((thread) => thread.projectPath.startsWith('games/')).map((thread) => thread.id);
    },
    async listMessages(threadId: string, limit = 2000) {
      const [ref, count] = messageRequest.parse([threadId, limit]);
      input.assertActivation?.();
      const thread = await input.threadStore.get(ref);
      if (
        !thread ||
        thread.deletedAt ||
        thread.createdBy !== input.ownerUserId ||
        thread.projectPath.startsWith('games/')
      ) {
        return [];
      }
      input.assertActivation?.();
      const messages = await input.messageStore.getThreadEvidenceProjection(ref, count, input.ownerUserId);
      input.assertActivation?.();
      return messages;
    },
  };
}
