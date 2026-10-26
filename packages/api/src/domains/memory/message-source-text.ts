import { type MessageContent, serializeContextAttachmentsPrompt } from '@cat-cafe/shared';

/** Text as displayed by the existing content-block renderer. The transport serialization of
 * context attachments is not prose. Preserve each original text/quote/comment without paraphrase. */
export function messageSourceText(content: string, blocks?: readonly MessageContent[]): string {
  if (!blocks?.some((block) => block.type === 'text' || block.type === 'context_attachment' || block.type === 'code'))
    return content;
  const parts = blocks.flatMap((block) => {
    if (block.type === 'text') return [block.text];
    if (block.type === 'code') return [block.code];
    if (block.type === 'context_attachment') {
      const attachment = block.attachment;
      if (attachment.kind === 'quote') return [attachment.text, attachment.comment ?? ''].filter(Boolean);
    }
    return [];
  });
  // Callback posts may keep prose separately from attachment-only blocks,
  // exactly as ContentBlocks' fallbackText does. Remove only the proved
  // serialized suffix belonging to these same structured attachments.
  if (!blocks.some((block) => block.type === 'text')) {
    const attachments = blocks.flatMap((block) => (block.type === 'context_attachment' ? [block.attachment] : []));
    const suffix = attachments.length ? serializeContextAttachmentsPrompt(attachments) : '';
    const spoken = suffix && content.endsWith(suffix) ? content.slice(0, -suffix.length).trimEnd() : content;
    if (spoken.trim()) parts.unshift(spoken);
  }
  return parts.join('\n\n');
}
