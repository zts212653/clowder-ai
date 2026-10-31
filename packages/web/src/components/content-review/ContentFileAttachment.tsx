import { type MessageContent, projectFileContent } from '@cat-cafe/shared';
import { ChatWorkCard } from '../artifacts/ChatWorkCard';
import { useContentOpen } from './useContentOpen';
import type { PublishedMessageCoordinate } from './usePublishedContent';

/** A human attachment and a cat's file card project the same card, opener and operations. */
export function ContentFileAttachment({
  block,
  publication,
  index,
}: {
  block: Extract<MessageContent, { type: 'file' }>;
  publication?: PublishedMessageCoordinate;
  index: number;
}) {
  const opening = useContentOpen(publication, JSON.stringify([block.url, publication?.messageId, index]));
  const { kind } = projectFileContent({ name: block.fileName, url: block.url, mime: block.mimeType });
  const artifact = {
    type: kind === 'image' || kind === 'video' || kind === 'audio' ? kind : ('file' as const),
    name: block.fileName,
    mime: block.mimeType,
    url: block.url,
    catId: null,
    createdAt: Number(publication?.messageRevision) || 0,
    sourceMessageId: publication?.messageId ?? null,
    publicationItem: { kind: 'content-block' as const, index },
  };
  const open = () =>
    publication
      ? opening.openContent({
          kind: 'message-file',
          url: block.url,
          name: block.fileName,
          mime: block.mimeType,
          coordinate: publication,
          item: { kind: 'content-block', index },
          origin: { kind: 'chat-file-link', threadId: publication.threadId, messageId: publication.messageId },
        })
      : Promise.resolve(false);
  return (
    <div className="chat-work-card">
      <ChatWorkCard
        artifact={artifact}
        onSelect={() => void open()}
        onOpen={() => void open()}
        disabled={!publication}
        busy={opening.busy}
        subtitle={`${block.mimeType} · ${Math.ceil(block.fileSize / 1024)} KB`}
        copyName={block.fileName}
      />
      {opening.error && <output role="alert">{opening.error}</output>}
      {opening.lightbox}
    </div>
  );
}
