'use client';
import { type RichCardBlock, type ThreadArtifactDTO, workReferenceCardSchema } from '@cat-cafe/shared';
import { ChatWorkCard } from '@/components/artifacts/ChatWorkCard';
import { useNearWorkViewport } from '@/components/artifacts/useNearWorkViewport';
import { useWorkCardDescription } from '@/components/artifacts/useWorkCardDescription';
import { useWorkCardOpen } from '@/components/artifacts/useWorkCardOpen';

/** The source card remains pinned even after its owner has published a newer version. */
export function LivingWorkCard({
  block,
  messageId,
  catId,
}: {
  block: RichCardBlock;
  messageId?: string;
  catId?: string;
}) {
  const parsed = workReferenceCardSchema.safeParse(block);
  return parsed.success ? (
    <FixedWorkCard block={parsed.data} messageId={messageId} catId={catId} />
  ) : (
    <p role="alert">作品引用暂时无法核对。</p>
  );
}

function FixedWorkCard({
  block,
  messageId,
  catId,
}: {
  block: ReturnType<typeof workReferenceCardSchema.parse>;
  messageId?: string;
  catId?: string;
}) {
  const reference = block.meta.reference;
  const { ref, near } = useNearWorkViewport<HTMLDivElement>();
  const read = useWorkCardDescription(reference, near);
  const opening = useWorkCardOpen(reference, block.title, messageId);
  const description =
    read.description ??
    (opening.description?.asset.ownerRevision === reference.ownerRevision ? opening.description : null);
  const artifact: ThreadArtifactDTO = {
    type: description?.asset.mediaType.startsWith('image/') ? 'image' : 'video',
    name: block.title,
    catId: description?.origin?.publisherCatId ?? catId ?? null,
    createdAt: 0,
    sourceMessageId: messageId ?? null,
    url: `/api/content-publications/${encodeURIComponent(reference.contentRef)}/media/${reference.ownerRevision}`,
    work: {
      ...reference,
      currentOwnerRevision: Math.max(
        description?.currentOwnerRevision ?? reference.ownerRevision,
        opening.description?.currentOwnerRevision ?? 0,
      ),
    },
  };
  return (
    <div ref={ref} className="chat-work-card" data-work-reference={JSON.stringify(reference)}>
      <ChatWorkCard
        artifact={artifact}
        busy={opening.busy}
        description={description}
        previewPending={!near || read.loading}
        onSelect={() => void opening.open('lightbox')}
        onOpen={() => void opening.open('work-mode')}
        onLatest={() => void opening.open('lightbox', true)}
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
