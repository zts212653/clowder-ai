import { type MessageContent, serializeContextAttachmentsPrompt } from '@cat-cafe/shared';
import type { IMessageStore } from '../domains/cats/services/stores/ports/MessageStore.js';
import { canViewMessage, type Viewer } from '../domains/cats/services/stores/visibility.js';

/** Reader projection of stored attachments; writer admission already owns validation.
 * Do not re-apply today's write budget to a historical source during a full drill. */
export function projectCallbackMessageBody(message: { content: string; contentBlocks?: readonly MessageContent[] }): {
  content: string;
  contentLength: number;
  contentBlocks?: readonly MessageContent[];
} {
  const attachments = message.contentBlocks?.flatMap((block) =>
    block.type === 'context_attachment' ? [block.attachment] : [],
  );
  const content = attachments?.length
    ? [message.content, serializeContextAttachmentsPrompt(attachments)].filter(Boolean).join('\n')
    : message.content;
  return {
    content,
    contentLength: content.length,
    ...(message.contentBlocks?.length ? { contentBlocks: message.contentBlocks } : {}),
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
    return projectCallbackMessageBody({
      content: persisted.map((source) => source.content).join('\n\n'),
      contentBlocks: persisted.flatMap((source) => source.contentBlocks ?? []),
    });
  } catch (error) {
    scope.onSourceError?.(error);
    // Keep the exact entry/drill visible but withhold full-read evidence. One
    // missing source must not prevent other readable bodies from being returned.
    return { content: '', contentLength: 0, sourceUnavailableReason: 'queued_body_source_unavailable' };
  }
}
