import type {
  ContentModificationContextCatalogue,
  ContextAttachment,
  MediaContextAttachment,
  MessageContent,
} from '@cat-cafe/shared';

/** One request a cat took over from a sent media message, with the words the chat line needs. */
export interface MediaRequestJoin {
  requestId: string;
  /** Who is working on it, in the words the person knows the cat by. */
  targetName: string;
  /** The picture's own title, as it stood in the attachment the person sent. */
  contentTitle: string;
  /** How many places the message covered; the whole work covers none. */
  placeCount: number;
}

const isMedia = (attachment: ContextAttachment): attachment is MediaContextAttachment => attachment.kind === 'media';

/** Every work in a sent message keeps its own owner/status join. */
export function mediaAttachmentsOf(blocks: readonly MessageContent[] | undefined): MediaContextAttachment[] {
  return (blocks ?? []).flatMap((block) =>
    block.type === 'context_attachment' && isMedia(block.attachment) ? [block.attachment] : [],
  );
}
/** Legacy single-work consumers may not silently choose a gallery's first item. */
export function mediaAttachmentOf(blocks: readonly MessageContent[] | undefined): MediaContextAttachment | null {
  const attachments = mediaAttachmentsOf(blocks);
  return attachments.length === 1 ? attachments[0] : null;
}

type CatalogueRequest = ContentModificationContextCatalogue['requests'][number];

/**
 * Whether this request is the takeover of this exact Human message: the owner's own `record.progress` says it came from
 * a Human message with this id. A request that was generated for the same id belongs to that message's own
 * presentation, so it is not one.
 */
const isTakeoverOf = ({ record }: CatalogueRequest, messageId: string) =>
  record.progress.sourceKind === 'human_message' && record.progress.sourceMessageId === messageId;

/** A selected takeover ends discovery only for that attachment; unselected legacy records keep their source-scoped join. */
export function hasRequestFromMessage(
  catalogue: ContentModificationContextCatalogue,
  messageId: string,
  attachmentId?: string,
): boolean {
  return catalogue.requests.some(
    (request) =>
      isTakeoverOf(request, messageId) &&
      (!attachmentId ||
        !request.record.progress.sourceAttachmentId ||
        request.record.progress.sourceAttachmentId === attachmentId),
  );
}

/** Requests are joined through the original Human and the exact selected attachment, never a sibling's label. */
export function mediaRequestsForMessage(
  catalogue: ContentModificationContextCatalogue,
  messageId: string,
  attachment: MediaContextAttachment,
  resolveCatName: (catId: string) => string | undefined,
): MediaRequestJoin[] {
  return catalogue.requests
    .filter(
      (request) =>
        isTakeoverOf(request, messageId) &&
        (!request.record.progress.sourceAttachmentId || request.record.progress.sourceAttachmentId === attachment.id),
    )
    .sort((a, b) => a.record.createdAt - b.record.createdAt || a.record.requestId.localeCompare(b.record.requestId))
    .map(({ record }) => ({
      requestId: record.requestId,
      targetName:
        // The persisted target id owns identity; its current roster name outranks a generic context label.
        resolveCatName(record.payload.targetCatId) ??
        catalogue.contexts.find((context) => context.requestIds.includes(record.requestId))?.targetName ??
        record.payload.targetCatId,
      contentTitle: attachment.title,
      placeCount: attachment.selections.length,
    }));
}
