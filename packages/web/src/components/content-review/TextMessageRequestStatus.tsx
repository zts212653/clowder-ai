import type { ChatMessage } from '@/stores/chat-types';
import { ModificationProgressLine } from './ModificationProgressLine';
import { ModificationProgressRow } from './ModificationProgressRow';
import { describeModificationReadFailure } from './modification-progress-copy';
import { type TextRequestSubject, textRequestSubjectOf } from './text-message-request';
import { useTextMessageRequest } from './useTextMessageRequest';

type StatusMessage = Pick<ChatMessage, 'id' | 'timestamp' | 'contentBlocks' | 'extra'>;
type ResolveCatName = (catId: string) => string | undefined;

function Status({
  message,
  subject,
  resolveCatName,
  ongoingOnly,
}: {
  message: StatusMessage;
  subject: TextRequestSubject;
  resolveCatName: ResolveCatName;
  ongoingOnly?: boolean;
}) {
  const { found, failed, reload } = useTextMessageRequest({ messageId: message.id, sentAt: message.timestamp });
  // A failed read says "cannot tell", never "no request"; once a request is found its own line reports its own state.
  if (!found && !failed) return null;
  return (
    <div data-testid="text-message-request" className="min-w-0">
      {found ? (
        <ModificationProgressLine
          requestId={found.requestId}
          targetName={resolveCatName(found.targetCatId) ?? found.targetCatId}
          contentTitle={subject.title}
          placeCount={subject.placeCount}
          ongoingOnly={ongoingOnly}
        />
      ) : (
        <ModificationProgressRow copy={describeModificationReadFailure()} handlers={{ reload: () => void reload() }} />
      )}
    </div>
  );
}

/**
 * Under a sent message that quotes places of a file: the live progress of the request a cat took over from exactly that
 * message, with the one action its state allows. Nothing is written onto the message; the line is joined from the
 * owner's own record, so before a cat takes the message over there is nothing true to say and nothing is shown. A
 * message that already has its own request headline (a generated "请猫修改" request) keeps that presentation instead.
 * Only a message that could ever have been taken over (`textRequestSubjectOf`) mounts anything, so an ordinary message
 * costs one check.
 */
export function TextMessageRequestStatus({
  message,
  resolveCatName,
  ongoingOnly,
}: {
  message: StatusMessage;
  resolveCatName: ResolveCatName;
  ongoingOnly?: boolean;
}) {
  const subject = message.extra?.contentModificationRequestV1 ? null : textRequestSubjectOf(message.contentBlocks);
  return subject ? (
    <Status message={message} subject={subject} resolveCatName={resolveCatName} ongoingOnly={ongoingOnly} />
  ) : null;
}
