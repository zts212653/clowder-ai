'use client';
import type { MediaContextAttachment } from '@cat-cafe/shared';
import { useComposerContextAttachments } from '@/components/useComposerContextAttachments';
import { useChatStore } from '@/stores/chatStore';
import type { FloatingArtwork } from './ArtworkLightboxScope';
import { composerAttachments } from './media-chat-composer';

type Reference = FloatingArtwork['reference'];

/** A presentation keeps its coordinates, while marks are always read from the original draft or message. */
export function useLiveArtworkReference(reference: Reference) {
  const origin = reference?.origin;
  useComposerContextAttachments(origin?.threadId ?? '');
  useChatStore((state) => state.pendingChatInsert);
  const draft = origin?.kind === 'composer' ? composerAttachments(origin.threadId) : [];
  const message = useChatStore((state) => {
    if (origin?.kind !== 'message') return undefined;
    const messages =
      origin.threadId === state.currentThreadId ? state.messages : state.threadStates[origin.threadId]?.messages;
    return messages?.find((item) => item.id === origin.messageId);
  });
  const queued = useChatStore((state) => {
    if (origin?.kind !== 'message') return undefined;
    const queue = origin.threadId === state.currentThreadId ? state.queue : state.threadStates[origin.threadId]?.queue;
    return queue?.find((item) => item.threadId === origin.threadId && item.messageId === origin.messageId);
  });
  // History owns a delivered input even when it no longer contains attachments.
  const blocks = message ? message.contentBlocks : queued?.messagePreview?.contentBlocks;
  const attachments =
    origin?.kind === 'composer'
      ? draft.filter((item): item is MediaContextAttachment => item.kind === 'media')
      : origin?.kind === 'message'
        ? (blocks ?? []).flatMap((block) =>
            block.type === 'context_attachment' && block.attachment.kind === 'media' ? [block.attachment] : [],
          )
        : undefined;
  const attachment = attachments?.find((item) => item.id === reference?.attachment.id);
  return {
    attachments,
    reference: !origin
      ? reference
      : reference && attachment
        ? {
            ...reference,
            attachment,
            selectionId: attachment.selections.some((item) => item.id === reference.selectionId)
              ? reference.selectionId
              : undefined,
          }
        : undefined,
  };
}
