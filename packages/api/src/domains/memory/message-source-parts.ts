import {
  type MessageContent,
  type MessageSourcePart,
  type QuoteContextAttachment,
  serializeContextAttachmentsPrompt,
} from '@cat-cafe/shared';

export interface MessageSourceTextPart {
  part: MessageSourcePart;
  text: string;
  quotation?: QuoteContextAttachment;
}

/** Keep the renderer's text leaves separate so a quote and its publisher's comment cannot swap authors. */
export function messageSourceParts(content: string, blocks?: readonly MessageContent[]): MessageSourceTextPart[] {
  if (!blocks?.some((block) => ['text', 'context_attachment', 'code'].includes(block.type)))
    return [{ part: { kind: 'body' }, text: content }];
  const parts = blocks.flatMap((block, blockIndex): MessageSourceTextPart[] => {
    if (block.type === 'text') return [{ part: { kind: 'text', blockIndex }, text: block.text }];
    if (block.type === 'code') return [{ part: { kind: 'code', blockIndex }, text: block.code }];
    if (block.type !== 'context_attachment' || block.attachment.kind !== 'quote') return [];
    const quotation = block.attachment;
    return [
      ...(quotation.text ? [{ part: { kind: 'quote' as const, blockIndex }, text: quotation.text, quotation }] : []),
      ...(quotation.comment
        ? [{ part: { kind: 'comment' as const, blockIndex }, text: quotation.comment, quotation }]
        : []),
    ];
  });
  if (!blocks.some((block) => block.type === 'text')) {
    const attachments = blocks.flatMap((block) => (block.type === 'context_attachment' ? [block.attachment] : []));
    const suffix = attachments.length ? serializeContextAttachmentsPrompt(attachments) : '';
    const spoken = suffix && content.endsWith(suffix) ? content.slice(0, -suffix.length).trimEnd() : content;
    if (spoken.trim()) parts.unshift({ part: { kind: 'body' }, text: spoken });
  }
  return parts;
}
