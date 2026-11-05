import { useCatData } from '@/hooks/useCatData';
import type { ChatMessage } from '@/stores/chat-types';
import { useChatStore } from '@/stores/chatStore';
import { ModificationProgressLine } from './ModificationProgressLine';
import { ModificationProgressRow } from './ModificationProgressRow';
import { type MediaChatTarget, sameMediaSource } from './media-chat-selection';
import { mediaAttachmentsOf, mediaRequestsForMessage } from './media-message-request';
import { sameMediaContentWithAdvancedReview } from './media-work-identity';
import { describeModificationReadFailure } from './modification-progress-copy';
import { useMediaMessageRequests } from './useMediaMessageRequests';

/** The canvas reads the same exact Human-message progress as Chat, including its original cancel action. */
export function ImageWorkProgress({ target }: { target: MediaChatTarget | null }) {
  const messages = useChatStore((state) => state.messages);
  const candidates = target
    ? messages.filter((item) => {
        if (item.type !== 'user' || item.extra?.contentModificationRequestV1) return false;
        return mediaAttachmentsOf(item.contentBlocks).some(
          (attachment) =>
            attachment.mediaType === target.mediaType &&
            (sameMediaSource(attachment, target) || sameMediaContentWithAdvancedReview(attachment, target)),
        );
      })
    : [];
  return target && candidates.length ? <ImageWorkRequests target={target} messages={candidates} /> : null;
}

function ImageWorkRequests({ target, messages }: { target: MediaChatTarget; messages: ChatMessage[] }) {
  const { getCatById } = useCatData();
  // The newest message bounds discovery only. Every candidate is joined to the actual owner results below.
  const newest = messages[messages.length - 1];
  const { catalogue, failed, reload } = useMediaMessageRequests({
    messageId: newest.id,
    sentAt: newest.timestamp,
    attachment: target,
  });
  const joined = catalogue
    ? messages.flatMap((message) => {
        return mediaAttachmentsOf(message.contentBlocks).flatMap((attachment) =>
          sameMediaSource(attachment, target) || sameMediaContentWithAdvancedReview(attachment, target)
            ? mediaRequestsForMessage(catalogue, message.id, attachment, (id) => getCatById(id)?.displayName)
            : [],
        );
      })
    : [];
  if (!joined.length && !failed) return null;
  return (
    <div className="shrink-0 px-3 py-1 text-xs" data-testid="image-work-progress">
      {joined.length ? (
        joined.map((item) => <ModificationProgressLine key={item.requestId} {...item} ongoingOnly />)
      ) : (
        <ModificationProgressRow copy={describeModificationReadFailure()} handlers={{ reload: () => void reload() }} />
      )}
    </div>
  );
}
