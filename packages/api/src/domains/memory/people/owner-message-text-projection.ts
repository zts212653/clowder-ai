import type { StoredMessage } from '../../cats/services/stores/ports/MessageStore.js';

type OwnerMessageTextView = Pick<StoredMessage, 'content' | 'contentBlocks'>;
type MessageContentBlock = NonNullable<OwnerMessageTextView['contentBlocks']>[number];
type QuoteContextAttachment = Extract<
  Extract<MessageContentBlock, { type: 'context_attachment' }>['attachment'],
  { kind: 'quote' }
>;

export type OwnerMessageTextSegment =
  | { kind: 'message_body'; text: string }
  | {
      kind: 'quote_comment';
      text: string;
      contentBlockIndex: number;
      quoteAttachment: QuoteContextAttachment;
    };

export function normalizeOwnerMessageText(value: string): string {
  return value.normalize('NFKC').trim();
}

/**
 * Text authored by the owner of the outer message.
 *
 * A quote attachment carries two speakers: `text` belongs to the quoted source,
 * while `comment` is the outer owner's response. Keeping those as separate
 * segments prevents a quoted third party from being laundered into owner truth.
 */
export function ownerMessageTextSegments(message: OwnerMessageTextView): OwnerMessageTextSegment[] {
  const segments: OwnerMessageTextSegment[] = [];
  const body = normalizeOwnerMessageText(message.content);
  if (body) segments.push({ kind: 'message_body', text: body });

  for (const [contentBlockIndex, block] of (message.contentBlocks ?? []).entries()) {
    if (block.type !== 'context_attachment' || block.attachment.kind !== 'quote') continue;
    const comment = block.attachment.comment ? normalizeOwnerMessageText(block.attachment.comment) : '';
    if (!comment) continue;
    segments.push({
      kind: 'quote_comment',
      text: comment,
      contentBlockIndex,
      quoteAttachment: block.attachment,
    });
  }
  return segments;
}

/** An excerpt must identify exactly one owner-authored segment. */
export function resolveOwnerMessageExcerptSegment(
  message: OwnerMessageTextView,
  excerpt: string,
): OwnerMessageTextSegment | null {
  const normalizedExcerpt = normalizeOwnerMessageText(excerpt);
  if (!normalizedExcerpt) return null;
  const matches = ownerMessageTextSegments(message).filter((segment) => segment.text.includes(normalizedExcerpt));
  return matches.length === 1 ? matches[0] : null;
}

/**
 * Preserve the historical digest for messages whose only owner-authored
 * evidence is the body. Once a quote comment exists, bind its full attachment
 * coordinate so immediate and deferred revalidation both fail closed if the
 * comment, quoted text, source identity, selection, attachment id, or position
 * changes.
 */
export function ownerMessageTextDigestMaterial(message: OwnerMessageTextView): unknown {
  const body = normalizeOwnerMessageText(message.content);
  const comments = ownerMessageTextSegments(message).filter(
    (segment): segment is Extract<OwnerMessageTextSegment, { kind: 'quote_comment' }> =>
      segment.kind === 'quote_comment',
  );
  if (comments.length === 0) return body;
  return {
    domain: 'f276-owner-message-text-v2',
    body,
    quoteComments: comments.map((segment) => ({
      contentBlockIndex: segment.contentBlockIndex,
      attachment: {
        ...segment.quoteAttachment,
        comment: segment.text,
      },
    })),
  };
}
