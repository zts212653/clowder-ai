'use client';
import type { ThreadArtifactDTO } from '@cat-cafe/shared';
import { ChatWorkCard } from '@/components/artifacts/ChatWorkCard';
import { useNearWorkViewport } from '@/components/artifacts/useNearWorkViewport';
import { useWorkCardDescription } from '@/components/artifacts/useWorkCardDescription';
import type { PublishedMessageCoordinate } from '@/components/content-review/usePublishedContent';
import { inferFileKind } from '@/lib/file-kind';
import type { RichFileBlock } from '@/stores/chat-types';
import { useChatStore } from '@/stores/chatStore';
import { isSafeFileUrl, useFileCardOpen } from './useFileCardOpen';
import { useRegisteredFileWork } from './useRegisteredFileWork';

const VIDEO_EXTENSIONS = /\.(mp4|mov|webm|avi|mkv|m4v|ogv)$/i;
type FileBlockProps = {
  block: RichFileBlock;
  publication?: PublishedMessageCoordinate;
  sourceThreadId?: string;
  messageId?: string;
  sourceMessageIds?: readonly string[];
  catId?: string;
};

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
  const video = !!block.mimeType?.startsWith('video/') || VIDEO_EXTENSIONS.test(block.fileName);
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
    type: video ? 'video' : inferFileKind(block.fileName) === 'image' ? 'image' : 'file',
    name: block.fileName,
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
        previewPending={!!reference && read.loading}
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
