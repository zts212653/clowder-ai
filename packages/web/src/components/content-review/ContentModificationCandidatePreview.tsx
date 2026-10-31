import type {
  ContentModificationCandidate,
  NormalizedModificationSelection,
  ReviewedMediaAsset,
} from '@cat-cafe/shared';
import Image from 'next/image';
import { API_URL } from '@/utils/api-client';
import { replyBodyCopy } from '../reply-body.shell-copy';
import { useShellCopy } from '../shell/shell-copy';
import { MediaVersionCompare } from './media-compare/MediaVersionCompare';

export function ContentModificationCandidatePreview({
  candidate,
  original,
  selections = [],
}: {
  candidate: ContentModificationCandidate;
  original?: ReviewedMediaAsset;
  selections?: readonly NormalizedModificationSelection[];
}) {
  const t = useShellCopy(replyBodyCopy);
  return (
    <>
      {candidate.kind === 'media' ? (
        <>
          {original ? (
            <MediaVersionCompare
              original={{ asset: original, label: '原版' }}
              candidate={{ asset: candidate.asset, label: '候选版本' }}
              fallback={<CandidateMedia asset={candidate.asset} />}
            />
          ) : (
            <CandidateMedia asset={candidate.asset} />
          )}
          <div className="space-y-2 text-sm">
            {candidate.responses.map((response) => (
              <p key={response.annotationId}>{response.explanation}</p>
            ))}
          </div>
        </>
      ) : (
        <>
          <p className="whitespace-pre-wrap text-sm">{candidate.proposal.response}</p>
          <section aria-label="修改前后对比" className="space-y-3">
            {candidate.proposal.edits.map((edit) => {
              // Numbers belong to the immutable request's quote order, not the patch's order or its offsets.
              // An unnamed edit (including a legacy proposal) remains reviewable without guessing its source.
              const index = edit.selectionId ? selections.findIndex((item) => item.id === edit.selectionId) : -1;
              const place = index < 0 ? undefined : selections[index];
              return (
                <div
                  key={`${edit.start}:${edit.end}`}
                  data-text-edit
                  data-selection-id={edit.selectionId}
                  className="overflow-auto rounded border border-cafe-subtle text-xs"
                >
                  <p className="px-2 py-1 font-medium text-cafe-secondary">
                    {place ? t.place(index + 1) : t.unboundEdit}
                  </p>
                  {place?.instruction ? <p className="px-2 pb-1 text-cafe-secondary">{place.instruction}</p> : null}
                  <p className="px-2 py-1 text-cafe-secondary">原文</p>
                  <pre className="whitespace-pre-wrap break-words bg-[var(--semantic-critical-surface)] p-2">
                    <del>{edit.expectedText || '（此处原无内容）'}</del>
                  </pre>
                  <p className="px-2 py-1 text-cafe-secondary">修改后</p>
                  <pre className="whitespace-pre-wrap break-words bg-[var(--semantic-success-surface)] p-2">
                    <ins>{edit.replacement || '（删除此处内容）'}</ins>
                  </pre>
                </div>
              );
            })}
          </section>
        </>
      )}
    </>
  );
}

/** This is the existing independently authorized candidate read, without an original pair. */
function CandidateMedia({ asset }: { asset: ReviewedMediaAsset }) {
  const src = `${API_URL}/api/content-publications/${encodeURIComponent(asset.contentRef)}/media/${asset.ownerRevision}`;
  return asset.media.kind === 'image' ? (
    <Image
      unoptimized
      width={asset.media.width}
      height={asset.media.height}
      className="max-h-80 w-full object-contain"
      alt="返回的图片新版本"
      src={src}
    />
  ) : (
    <video controls className="max-h-80 w-full" aria-label="返回的视频新版本" src={src} />
  );
}
