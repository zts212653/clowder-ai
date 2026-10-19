import type { MediaContextAttachment } from '@cat-cafe/shared';
import type { ChatMessage } from '@/stores/chat-types';
import { ModificationProgressLine } from './ModificationProgressLine';
import { ModificationProgressRow } from './ModificationProgressRow';
import { mediaAttachmentsOf, mediaRequestsForMessage } from './media-message-request';
import { describeModificationReadFailure } from './modification-progress-copy';
import { useMediaMessageRequests } from './useMediaMessageRequests';

type StatusMessage = Pick<ChatMessage, 'id' | 'timestamp' | 'contentBlocks' | 'extra'>;
type ResolveCatName = (catId: string) => string | undefined;

function Status({
  message,
  attachment,
  resolveCatName,
}: {
  message: StatusMessage;
  attachment: MediaContextAttachment;
  resolveCatName: ResolveCatName;
}) {
  const { catalogue, failed, reload } = useMediaMessageRequests({
    messageId: message.id,
    sentAt: message.timestamp,
    attachment,
  });
  const joined = catalogue ? mediaRequestsForMessage(catalogue, message.id, attachment, resolveCatName) : [];
  // A failed read says "cannot tell", never "no request"; once a request is listed its own line reports its own state.
  if (joined.length === 0 && !failed) return null;
  return (
    <div data-testid="media-message-request" className="min-w-0">
      {joined.length === 0 ? (
        <ModificationProgressRow copy={describeModificationReadFailure()} handlers={{ reload: () => void reload() }} />
      ) : (
        joined.map((item) => <ModificationProgressLine key={item.requestId} {...item} />)
      )}
    </div>
  );
}

/**
 * Under a sent image message: the live progress of each request a cat took over from exactly that message, with
 * the one action its state allows. Nothing is written onto the message; the line is joined from the owner's own record,
 * so before a cat takes the message over there is nothing true to say and nothing is shown. A message that already has
 * its own request headline (a generated "请猫修改" request) keeps that presentation instead. Only a message that carries
 * a media attachment mounts anything, so an ordinary message costs one check.
 */
export function MediaMessageRequestStatus({
  message,
  resolveCatName,
}: {
  message: StatusMessage;
  resolveCatName: ResolveCatName;
}) {
  const attachments = message.extra?.contentModificationRequestV1 ? [] : mediaAttachmentsOf(message.contentBlocks);
  return (
    <>
      {attachments.map((attachment) => (
        <Status key={attachment.id} message={message} attachment={attachment} resolveCatName={resolveCatName} />
      ))}
    </>
  );
}
