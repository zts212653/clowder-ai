'use client';
import {
  type ContentModificationCandidate,
  type ContentModificationDetailView,
  type ReviewedMediaAsset,
  reviewedMediaAssetSchema,
} from '@cat-cafe/shared';
import { useEffect, useState } from 'react';
import { apiFetch } from '@/utils/api-client';
import { ContentModificationCandidatePreview } from '../ContentModificationCandidatePreview';

/** The original is the prepared immutable snapshot, never the mutable file's current bytes. */
export function ModificationMediaCompare({
  view,
  candidate,
}: {
  view: ContentModificationDetailView;
  candidate: Extract<ContentModificationCandidate, { kind: 'media' }>;
}) {
  const prepared = view.record.progress.prepared;
  const source = view.record.payload.source;
  const original = prepared?.kind === 'media' ? prepared : source.kind === 'publication' ? source : null;
  const contentRef = original?.contentRef,
    ownerRevision = original?.ownerRevision;
  const path = original
    ? `/api/content-publications/${encodeURIComponent(original.contentRef)}?ownerRevision=${original.ownerRevision}`
    : null;
  const [read, setRead] = useState<{ path: string; asset?: ReviewedMediaAsset; error?: boolean } | null>(null);
  useEffect(() => {
    if (!path || !contentRef || !ownerRevision) return;
    const abort = new AbortController();
    void apiFetch(path, { signal: abort.signal })
      .then(async (response) => {
        if (!response.ok) throw new Error('原版当前无法读取，候选仍保留。');
        const data: unknown = await response.json();
        const parsed = reviewedMediaAssetSchema.safeParse(
          data && typeof data === 'object' && 'asset' in data ? data.asset : null,
        );
        if (!parsed.success) throw new Error('original_metadata_invalid');
        const asset = parsed.data;
        if (asset.contentRef !== contentRef || asset.ownerRevision !== ownerRevision)
          throw new Error('original_identity_changed');
        if (!abort.signal.aborted) setRead({ path, asset });
      })
      .catch(() => {
        if (!abort.signal.aborted) setRead({ path, error: true });
      });
    return () => abort.abort();
  }, [path, contentRef, ownerRevision]);
  const asset = read?.path === path ? read.asset : undefined;
  const failed = read?.path === path && read.error;
  const notice = !path
    ? '原版版本暂不可核对；以下仍可查看候选版本。'
    : failed
      ? '原版当前无法核对；以下仍可查看候选版本。'
      : !asset
        ? '正在核对原版；以下先显示候选版本。'
        : null;
  return (
    <>
      {notice ? (
        <p role={failed ? 'alert' : 'status'} className="text-sm text-cafe-muted">
          {notice}
        </p>
      ) : null}
      <div className="flex h-[min(55vh,640px)] min-h-80 flex-col">
        <ContentModificationCandidatePreview candidate={candidate} original={asset} />
      </div>
    </>
  );
}
