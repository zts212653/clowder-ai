import { createHash } from 'node:crypto';
import { type MessageContent, type RichBlock, serializeContextAttachmentsPrompt } from '@cat-cafe/shared';
import type { IMessageStore } from '../domains/cats/services/stores/ports/MessageStore.js';
import { canViewMessage, type Viewer } from '../domains/cats/services/stores/visibility.js';
import { buildSearchableMessageContent } from '../domains/memory/message-search-content.js';
import { messageSourceParts } from '../domains/memory/message-source-parts.js';

/** Only a single persisted original owns citation coordinates; merged Queue text does not. */
export function projectCallbackMessageCitation(message: Parameters<typeof projectCallbackMessageBody>[0]) {
  const canonical = buildSearchableMessageContent({
    content: message.content,
    contentBlocks: message.contentBlocks,
    richBlocks: message.extra?.rich?.blocks,
  });
  return {
    contentRevision: createHash('sha256').update(canonical).digest('hex'),
    sourceParts: messageSourceParts(message.content, message.contentBlocks).map(({ part, text }) => ({
      part,
      length: text.length,
    })),
  };
}

/** Reader projection of stored attachments; writer admission already owns validation.
 * Do not re-apply today's write budget to a historical source during a full drill. */
export function projectCallbackMessageBody(message: {
  content: string;
  contentBlocks?: readonly MessageContent[];
  extra?: { rich?: { blocks?: readonly RichBlock[] } };
}): {
  content: string;
  contentLength: number;
  contentBlocks?: readonly MessageContent[];
  richBlocks?: readonly RichBlock[];
} {
  const attachments = message.contentBlocks?.flatMap((block) =>
    block.type === 'context_attachment' ? [block.attachment] : [],
  );
  const content = attachments?.length
    ? [message.content, serializeContextAttachmentsPrompt(attachments)].filter(Boolean).join('\n')
    : message.content;
  const richBlocks = message.extra?.rich?.blocks;
  return {
    content,
    contentLength: content.length,
    ...(message.contentBlocks?.length ? { contentBlocks: message.contentBlocks } : {}),
    ...(richBlocks?.length ? { richBlocks } : {}),
  };
}

/** Queue text alone cannot prove that a persisted source's attachments were exposed. */
export async function projectQueuedCallbackMessageBody(
  entry: { entryId: string; content: string; messageId?: string | null; mergedMessageIds?: readonly string[] },
  store: Pick<IMessageStore, 'getById'>,
  scope: { threadId: string; userId: string; catId: string; viewer: Viewer; onSourceError?: (error: unknown) => void },
): Promise<ReturnType<typeof projectCallbackMessageBody> & { sourceUnavailableReason?: string }> {
  const queueBody = projectCallbackMessageBody({ content: entry.content });
  if (!entry.messageId && !entry.mergedMessageIds?.length) {
    return entry.content ? queueBody : { ...queueBody, sourceUnavailableReason: 'queued_body_not_persisted' };
  }
  try {
    const sourceIds = [
      ...new Set([entry.messageId, ...(entry.mergedMessageIds ?? [])].filter((id): id is string => Boolean(id))),
    ];
    const sources = await Promise.all(sourceIds.map((id) => store.getById(id)));
    if (
      sources.some(
        (source) =>
          !source ||
          source.threadId !== scope.threadId ||
          source.userId !== scope.userId ||
          source.deletedAt ||
          source._tombstone ||
          source.recall ||
          !canViewMessage(source, scope.viewer),
      )
    ) {
      return { content: '', contentLength: 0, sourceUnavailableReason: 'queued_body_source_changed' };
    }
    const persisted = sources.filter((source): source is NonNullable<typeof source> => source !== null);
    const richBlocks = persisted.flatMap((source) => (source.extra?.rich?.blocks ? source.extra.rich.blocks : []));
    return projectCallbackMessageBody({
      content: persisted.map((source) => source.content).join('\n\n'),
      contentBlocks: persisted.flatMap((source) => (source.contentBlocks ? source.contentBlocks : [])),
      ...(richBlocks.length > 0 ? { extra: { rich: { blocks: richBlocks } } } : {}),
    });
  } catch (error) {
    scope.onSourceError?.(error);
    // Keep the exact entry/drill visible but withhold full-read evidence. One
    // missing source must not prevent other readable bodies from being returned.
    return { content: '', contentLength: 0, sourceUnavailableReason: 'queued_body_source_unavailable' };
  }
}
