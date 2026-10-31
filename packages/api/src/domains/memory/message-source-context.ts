import { createHash } from 'node:crypto';
import {
  CONTEXT_ATTACHMENT_QUOTE_MAX_LENGTH,
  type MessageNavigationAdmission,
  type MessageNavigationReference,
} from '@cat-cafe/shared';
import type { StoredMessage } from '../cats/services/stores/ports/MessageStore.js';
import { buildSearchableMessageContent } from './message-search-content.js';
import { projectMessageSearchSpeaker } from './message-search-projection.js';
import { messageSourceText } from './message-source-text.js';

function sourceBody(message: StoredMessage): NonNullable<MessageNavigationAdmission['message']> {
  const canonical = buildSearchableMessageContent({
    content: message.content,
    contentBlocks: message.contentBlocks,
    richBlocks: message.extra?.rich?.blocks,
  });
  const text = messageSourceText(message.content, message.contentBlocks);
  return {
    threadId: message.threadId,
    messageId: message.id,
    content: text.slice(0, CONTEXT_ATTACHMENT_QUOTE_MAX_LENGTH),
    ...projectMessageSearchSpeaker(message),
    timestamp: message.timestamp,
    contentRevision: createHash('sha256').update(canonical).digest('hex'),
    truncated: text.length > CONTEXT_ATTACHMENT_QUOTE_MAX_LENGTH,
  };
}

/** Thin consumer of the same store and admission owner; no cached body grants a read/quote. */
export async function readMessageSourceContext(input: {
  admission: MessageNavigationAdmission;
  message: StoredMessage;
  count: number;
  signal?: AbortSignal;
  after: (threadId: string, messageId: string, limit: number) => Promise<StoredMessage[]>;
  readable: (ref: MessageNavigationReference & { messageId: string }) => Promise<StoredMessage | null>;
  revalidate: () => Promise<MessageNavigationAdmission | null>;
}): Promise<MessageNavigationAdmission | null> {
  const following: NonNullable<MessageNavigationAdmission['message']>[] = [];
  input.signal?.throwIfAborted();
  const rows = input.count > 0 ? await input.after(input.message.threadId, input.message.id, input.count) : [];
  for (const item of rows) {
    input.signal?.throwIfAborted();
    if (item.threadId !== input.message.threadId || item.id === input.message.id) continue;
    const current = await input.readable({ threadId: item.threadId, messageId: item.id });
    if (current) following.push(sourceBody(current));
    if (following.length >= input.count) break;
  }
  const source = await input.readable({ threadId: input.message.threadId, messageId: input.message.id });
  const fresh = await input.revalidate();
  input.signal?.throwIfAborted();
  if (
    !fresh ||
    !source ||
    fresh.target.contentRevision !== input.admission.target.contentRevision ||
    sourceBody(source).contentRevision !== fresh.target.contentRevision
  )
    return null;
  return { ...fresh, message: sourceBody(source), following };
}
