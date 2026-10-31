import {
  type ContextAttachment,
  ContextAttachmentsSchema,
  type MessageContent,
  serializeContextAttachmentsPrompt,
} from '@cat-cafe/shared';

function readContextAttachments(contentBlocks: readonly MessageContent[] | undefined): ContextAttachment[] {
  if (!contentBlocks) return [];
  return contentBlocks
    .filter(
      (block): block is Extract<MessageContent, { type: 'context_attachment' }> => block.type === 'context_attachment',
    )
    .map((block) => block.attachment);
}

export function serializeContextAttachmentsForPrompt(contentBlocks: readonly MessageContent[] | undefined): string {
  const attachments = readContextAttachments(contentBlocks);
  if (attachments.length === 0) return '';
  const validated = ContextAttachmentsSchema.parse(attachments);
  return serializeContextAttachmentsPrompt(validated);
}

export function appendContextAttachmentsToPrompt(
  content: string,
  contentBlocks: readonly MessageContent[] | undefined,
): string {
  const serialized = serializeContextAttachmentsForPrompt(contentBlocks);
  if (!serialized) return content;
  return content ? `${content}\n${serialized}` : serialized;
}
