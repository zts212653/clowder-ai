'use client';
import type { AssetContextAttachment } from '@cat-cafe/shared';
import { useChatStore } from '@/stores/chatStore';
import { API_URL } from '@/utils/api-client';

export function AssetAttachmentView({
  attachment,
  onRemove,
  threadId: sourceThreadId,
}: {
  attachment: AssetContextAttachment;
  onRemove?: () => void;
  threadId?: string;
}) {
  const activeThreadId = useChatStore((s) => s.currentThreadId);
  const threadId = sourceThreadId ?? activeThreadId;
  const work = attachment.work;
  const url = threadId
    ? `${API_URL}/api/works/${encodeURIComponent(work.reference.contentRef)}/video-assets/${work.reference.ownerRevision}/${work.metadataRevision}/${encodeURIComponent(work.assetId)}?threadId=${encodeURIComponent(threadId)}`
    : undefined;
  return (
    <span
      className="my-1 inline-flex max-w-full items-center gap-2 rounded-lg border border-cafe-subtle bg-cafe-surface px-2 py-1 text-xs"
      data-context-kind="asset"
    >
      {attachment.mediaType.startsWith('image/') && url ? (
        <img src={url} alt="" className="h-7 w-9 shrink-0 rounded object-cover" />
      ) : null}
      <span className="shrink-0 text-cafe-muted">素材</span>
      <span className="min-w-0 truncate">{attachment.name.split('/').at(-1)}</span>
      {onRemove ? (
        <button
          type="button"
          onClick={onRemove}
          aria-label={`移除素材 ${attachment.name}`}
          className="px-1 text-cafe-muted"
        >
          ×
        </button>
      ) : null}
    </span>
  );
}
