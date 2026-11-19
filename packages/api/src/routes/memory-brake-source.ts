import type { IMessageStore } from '../domains/cats/services/stores/ports/MessageStore.js';
import type { IThreadStore } from '../domains/cats/services/stores/ports/ThreadStore.js';
import { resolveThreadMessageVisibility } from '../domains/cats/services/stores/visibility.js';
import { canAccessThread } from '../domains/guides/guide-state-access.js';
import type { EventMemoryPort } from '../domains/memory/event/event-memory-port.js';

export interface BrakeSourceReaders {
  eventMemoryStore: Pick<EventMemoryPort, 'getEvent'>;
  threadStore: Pick<IThreadStore, 'get' | 'list'>;
  messageStore: Pick<IMessageStore, 'getById'>;
}

export async function readBrakeSource(eventId: string, owner: string, readers: BrakeSourceReaders) {
  const absent = { title: null, canOpen: false };
  const event = await readers.eventMemoryStore.getEvent(eventId, owner);
  if (!event || event.ownerUserId !== owner || event.trigger !== 'human_brake' || event.confidence === 'low')
    return absent;
  const thread = await readers.threadStore.get(event.threadId);
  if (!thread || thread.deletedAt) return absent;
  if (!canAccessThread(thread, owner)) {
    if (thread.createdBy !== 'system' || !(await readers.threadStore.list(owner)).some((t) => t.id === thread.id))
      return absent;
  }
  const message = await readers.messageStore.getById(event.messageId);
  if (!message || message.threadId !== thread.id || message.deletedAt) return absent;
  if (message.userId !== owner) return absent;
  if (!resolveThreadMessageVisibility({ includeQueuedUserMessages: true }, owner)(message)) return absent;
  return { title: thread.title?.trim() || null, canOpen: true, threadId: thread.id, messageId: message.id };
}
