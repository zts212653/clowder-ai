import type { MemoryOwnerSourceResponse } from '@cat-cafe/shared';
import type { IMessageStore } from '../domains/cats/services/stores/ports/MessageStore.js';
import type { IThreadStore } from '../domains/cats/services/stores/ports/ThreadStore.js';
import { resolveThreadMessageVisibility } from '../domains/cats/services/stores/visibility.js';
import { canAccessThread } from '../domains/guides/guide-state-access.js';
import type { StoredEventMemoryLifecycle } from '../domains/memory/EventMemoryStore.js';

export interface EventMemorySourceReaders {
  threadStore: Pick<IThreadStore, 'get' | 'list'>;
  messageStore: Pick<IMessageStore, 'getById'>;
}

export async function readEventMemorySource(
  event: StoredEventMemoryLifecycle,
  ownerUserId: string,
  readers: EventMemorySourceReaders,
): Promise<MemoryOwnerSourceResponse> {
  if (event.ownerUserId !== ownerUserId) return unavailable();
  const thread = await readers.threadStore.get(event.threadId);
  if (!thread || thread.deletedAt) return unavailable();
  if (!canAccessThread(thread, ownerUserId)) {
    const systemOwnedVisible =
      thread.createdBy === 'system' &&
      (await readers.threadStore.list(ownerUserId)).some((item) => item.id === thread.id);
    if (!systemOwnedVisible) return unavailable();
  }
  const message = await readers.messageStore.getById(event.messageId);
  if (!message || message.threadId !== thread.id || message.deletedAt || message.userId !== ownerUserId) {
    return unavailable();
  }
  if (!resolveThreadMessageVisibility({ includeQueuedUserMessages: true }, ownerUserId)(message)) {
    return unavailable();
  }
  return {
    status: 'ready',
    sources: [
      {
        label: thread.title?.trim() || '对话 · 标题没有记录下来',
        occurredAt: message.timestamp,
        canOpen: true,
        threadId: thread.id,
        messageId: message.id,
      },
    ],
  };
}

function unavailable(): MemoryOwnerSourceResponse {
  return { status: 'unavailable', sources: [] };
}
