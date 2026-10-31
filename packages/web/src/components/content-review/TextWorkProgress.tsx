import { useCatData } from '@/hooks/useCatData';
import { useChatStore } from '@/stores/chatStore';
import { TextMessageRequestStatus } from './TextMessageRequestStatus';
import { textRequestSubjectOf } from './text-message-request';

/** The document reads the original Human-message request, using the same progress and cancel consumer as Chat. */
export function TextWorkProgress({
  locator,
  revision,
}: {
  locator: { readonly worktreeId: string; readonly path: string };
  revision: string;
}) {
  const messages = useChatStore((state) => state.messages);
  const candidates = messages.filter(
    (item) =>
      item.type === 'user' &&
      !item.extra?.contentModificationRequestV1 &&
      !!textRequestSubjectOf(item.contentBlocks) &&
      item.contentBlocks?.some(
        (block) =>
          block.type === 'context_attachment' &&
          block.attachment.kind === 'quote' &&
          block.attachment.source.kind === 'workspace_file' &&
          block.attachment.source.worktreeId === locator.worktreeId &&
          block.attachment.source.path === locator.path &&
          block.attachment.source.revision === revision,
      ),
  );
  return candidates.length ? (
    <div className="shrink-0 px-3 py-1 text-xs" data-testid="text-work-progress">
      {candidates.map((message) => (
        <TextWorkProgressMessage key={message.id} message={message} />
      ))}
    </div>
  ) : null;
}

function TextWorkProgressMessage({ message }: { message: Parameters<typeof TextMessageRequestStatus>[0]['message'] }) {
  const { getCatById } = useCatData();
  return (
    <TextMessageRequestStatus
      message={message}
      resolveCatName={(catId) => getCatById(catId)?.displayName}
      ongoingOnly
    />
  );
}
