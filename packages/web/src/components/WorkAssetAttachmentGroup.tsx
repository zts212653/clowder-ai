'use client';
import type { AssetContextAttachment, ContextAttachment, MediaContextAttachment } from '@cat-cafe/shared';
import { AssetAttachmentView } from './AssetAttachmentView';
import { GalleryAttachmentGroup } from './content-review/GalleryAttachmentGroup';

export function assetGroupKey(item: ContextAttachment): string | null {
  const ref =
    item.kind === 'asset'
      ? item.work.reference
      : item.kind === 'media' && !item.gallery && item.source.kind === 'publication'
        ? item.source
        : null;
  return ref ? `${ref.contentRef}:${ref.ownerRevision}` : null;
}
export function WorkAssetAttachmentGroup({
  assets,
  media,
  compact,
  onRemove,
  threadId,
}: {
  assets: AssetContextAttachment[];
  media: MediaContextAttachment[];
  compact: boolean;
  onRemove?: (id: string) => void;
  threadId?: string;
}) {
  const title = `${assets[0]!.workTitle ?? '这支片'} · 第 ${assets[0]!.work.reference.ownerRevision} 版`;
  const chips = assets.map((item) => (
    <AssetAttachmentView
      key={item.id}
      attachment={item}
      threadId={threadId}
      onRemove={onRemove ? () => onRemove(item.id) : undefined}
    />
  ));
  if (media.length)
    return (
      <GalleryAttachmentGroup
        attachments={media}
        compact={compact}
        fromComposer
        onRemove={onRemove}
        materialTitle={title}
        materials={chips}
      />
    );
  return (
    <section className="min-w-0 max-w-full" aria-label={title}>
      <p className="text-xs font-medium text-cafe-muted">{title}</p>
      <div className="flex flex-wrap items-start gap-2">{chips}</div>
    </section>
  );
}
