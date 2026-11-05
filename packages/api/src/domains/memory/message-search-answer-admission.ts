import type { MessageSearchAnswerBinding, MessageSearchAnswerView } from '@cat-cafe/shared';
import { resolveThreadAccess } from '../cats/services/session/thread-access-policy.js';
import { matchesMessageSearchAnswer } from '../cats/services/stores/message-search-answer-binding.js';
import type { IMessageStore, StoredMessage } from '../cats/services/stores/ports/MessageStore.js';
import type { IThreadStore } from '../cats/services/stores/ports/ThreadStore.js';
import { canViewMessage, isEligibleReplyParent, type Viewer } from '../cats/services/stores/visibility.js';
import type {
  MessageSearchAnswerPublication,
  MessageSearchAnswerPublicationStore,
} from './MessageSearchAnswerPublicationStore.js';
import {
  MessageSearchAccessError,
  type MessageSearchPrincipal,
  type MessageSearchService,
} from './MessageSearchService.js';

interface AnswerReadOwner {
  store: MessageSearchAnswerPublicationStore;
  search: MessageSearchService;
  messages: Pick<IMessageStore, 'getById'>;
  threads: Pick<IThreadStore, 'get' | 'list'>;
}
/** Read-only admission through the original memory and message authorities. */
export async function assertAnswerDestination(
  threads: Pick<IThreadStore, 'get' | 'list'>,
  userId: string,
  threadId: string,
): Promise<void> {
  const thread = await threads.get(threadId);
  if (
    !thread ||
    thread.deletedAt ||
    (
      await resolveThreadAccess({
        threadStore: threads,
        thread,
        userId,
        request: { resource: 'transcript', action: 'read' },
      })
    ).status !== 200
  )
    throw new MessageSearchAccessError('Answer destination unavailable');
}
export function answerBinding(record: MessageSearchAnswerPublication): MessageSearchAnswerBinding | null {
  return record.response_digest && record.block_id
    ? {
        v: 1,
        publicationRef: record.publication_ref,
        blockId: record.block_id,
        responseDigest: record.response_digest,
      }
    : null;
}
export function isAnswerMessageReadable(message: StoredMessage, owner: string, viewer: Viewer): boolean {
  return (
    message.userId === owner &&
    !message.deletedAt &&
    !message._tombstone &&
    !message.recall &&
    isEligibleReplyParent(message, { threadId: message.threadId, viewer }) &&
    canViewMessage(message, viewer)
  );
}
export async function readMessageSearchAnswer(
  owner: AnswerReadOwner,
  messageId: string,
  blockId: string,
  principal: MessageSearchPrincipal,
  signal?: AbortSignal,
): Promise<MessageSearchAnswerView> {
  const unavailable: MessageSearchAnswerView = { status: 'unavailable' };
  const message = await owner.messages.getById(messageId);
  if (!message || !isAnswerMessageReadable(message, principal.userId, principal.viewer)) return unavailable;
  const binding = message.extra?.messageSearchAnswer;
  if (!binding || binding.blockId !== blockId || !matchesMessageSearchAnswer(message, binding)) return unavailable;
  const record = owner.store.get(binding.publicationRef);
  if (!record || record.owner_user_id !== principal.userId || record.response_digest !== binding.responseDigest)
    return unavailable;
  if (binding.forwardedFromMessageId) {
    const original = record.bound_message_id ? await owner.messages.getById(record.bound_message_id) : null;
    const originalBinding = answerBinding(record);
    if (
      !original ||
      !originalBinding ||
      record.bound_message_id !== binding.forwardedFromMessageId ||
      !isAnswerMessageReadable(original, principal.userId, principal.viewer) ||
      !matchesMessageSearchAnswer(original, originalBinding)
    )
      return unavailable;
    await assertAnswerDestination(owner.threads, principal.userId, original.threadId);
  } else if (record.bound_message_id !== message.id || record.target_thread_id !== message.threadId) return unavailable;
  await assertAnswerDestination(owner.threads, principal.userId, message.threadId);
  const response = owner.store.response(record);
  if (!response) return unavailable;
  const view = await owner.search.readAnswerSnapshot(response, { ...principal, publicReply: true }, signal);
  signal?.throwIfAborted();
  const current = await owner.messages.getById(messageId);
  await assertAnswerDestination(owner.threads, principal.userId, message.threadId);
  if (
    !current ||
    !isAnswerMessageReadable(current, principal.userId, principal.viewer) ||
    !matchesMessageSearchAnswer(current, binding)
  )
    return unavailable;
  if (binding.forwardedFromMessageId) {
    const original = await owner.messages.getById(binding.forwardedFromMessageId);
    const originalBinding = answerBinding(record);
    if (
      !original ||
      !originalBinding ||
      !isAnswerMessageReadable(original, principal.userId, principal.viewer) ||
      !matchesMessageSearchAnswer(original, originalBinding)
    )
      return unavailable;
    await assertAnswerDestination(owner.threads, principal.userId, original.threadId);
  }
  if (response.results.length && !view.response.results.length) return unavailable;
  return { status: 'available', publicationRef: record.publication_ref, createdAt: record.created_at, ...view };
}
