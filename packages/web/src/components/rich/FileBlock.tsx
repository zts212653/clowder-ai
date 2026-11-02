'use client';
import { projectFileContent, type ThreadArtifactDTO } from '@cat-cafe/shared';
import { ChatWorkCard } from '@/components/artifacts/ChatWorkCard';
import { useNearWorkViewport } from '@/components/artifacts/useNearWorkViewport';
import { useWorkCardDescription } from '@/components/artifacts/useWorkCardDescription';
import type { PublishedMessageCoordinate } from '@/components/content-review/usePublishedContent';
import type { RichFileBlock } from '@/stores/chat-types';
import { useChatStore } from '@/stores/chatStore';
import { isSafeFileUrl, useFileCardOpen } from './useFileCardOpen';
import { useRegisteredFileWork } from './useRegisteredFileWork';

type FileBlockProps = {
  block: RichFileBlock;
  publication?: PublishedMessageCoordinate;
  sourceThreadId?: string;
  messageId?: string;
  sourceMessageIds?: readonly string[];
  catId?: string;
};

function fileArtifactType(block: RichFileBlock): ThreadArtifactDTO['type'] {
  const { kind } = projectFileContent({ name: block.fileName, url: block.url, mime: block.mimeType });
  return kind === 'image' || kind === 'video' || kind === 'audio' ? kind : 'file';
}

export function FileBlock(props: FileBlockProps) {
  const { block, publication, sourceThreadId, messageId, sourceMessageIds } = props;
  // All three original-owner hooks discard pending navigation when this source changes.
  const sourceKey = JSON.stringify([
    block.url,
    sourceThreadId,
    messageId,
    sourceMessageIds,
    publication?.threadId,
    publication?.messageId,
    publication?.messageRevision,
    publication?.origins,
  ]);
  return <FileCard key={sourceKey} {...props} />;
}

function FileCard({ block, publication, sourceThreadId, messageId, sourceMessageIds, catId }: FileBlockProps) {
  const { ref, near } = useNearWorkViewport<HTMLDivElement>();
  const host = useChatStore((state) => state.currentThreadId);
  const originThread = sourceThreadId ?? publication?.threadId ?? host ?? undefined;
  const registered = useRegisteredFileWork(block.url, originThread, near);
  const reference = registered.artifact?.work ?? registered.reference ?? undefined;
  const read = useWorkCardDescription(reference, near);
  const type = fileArtifactType(block);
  const video = type === 'video';
  const opening = useFileCardOpen({
    block,
    publication,
    host,
    originThread,
    messageId,
    sourceMessageIds,
    registered,
    video,
  });
  const original: ThreadArtifactDTO = registered.artifact ?? {
    type,
    name: block.fileName,
    mime: block.mimeType,
    catId: catId ?? null,
    createdAt: Number(publication?.messageRevision) || 0,
    sourceMessageId: messageId ?? null,
    ...(isSafeFileUrl(block.url) ? { url: block.url } : {}),
  };
  const artifact = reference
    ? {
        ...original,
        work: {
          ...reference,
          currentOwnerRevision:
            read.description?.currentOwnerRevision ?? original.work?.currentOwnerRevision ?? reference.ownerRevision,
        },
      }
    : original;
  return (
    <div ref={ref} className="chat-work-card">
      <ChatWorkCard
        artifact={artifact}
        busy={opening.busy}
        description={read.description}
        previewPending={registered.loading || read.loading}
        disabled={!isSafeFileUrl(block.url)}
        onSelect={() => void opening.open('lightbox')}
        onOpen={() => void opening.open('work-mode')}
        onLatest={artifact.work ? () => void opening.open('lightbox', true) : undefined}
        testId="file-block-cover"
        copyName={block.fileName}
      />
      {opening.error && (
        <p role="alert" className="mt-2 text-xs text-cafe-error">
          {opening.error}
        </p>
      )}
      {opening.lightbox}
    </div>
  );
}
