import type { ArtifactReviewView, EntrustedWorkOwnerReadV1 } from '@cat-cafe/shared';
import { ReviewArtifactButton } from '@/components/content-review/ReviewArtifactButton';
import { reviewSurfaceFromPreparedRef } from '@/components/workbench/artifact-review-surface';

type Artifact = NonNullable<EntrustedWorkOwnerReadV1['preparedArtifact']>;

export function ScheduleArtifactActions({
  ownerRead,
  itemRef,
  artifactsLoading,
  displayTitle,
  onOpenArtifact,
  onOpenReview,
}: {
  ownerRead: EntrustedWorkOwnerReadV1;
  itemRef: string;
  artifactsLoading: boolean;
  /** The review title the card already shows; the opened tab carries the same name. */
  displayTitle?: string;
  onOpenArtifact?: (artifact: Artifact, itemRef: string, title?: string) => void;
  onOpenReview?: (review: ArtifactReviewView, itemRef: string) => void;
}) {
  const artifact = ownerRead.preparedArtifact;
  if (!artifact) return null;
  const loading = artifactsLoading && !reviewSurfaceFromPreparedRef(artifact.openInWorkspaceRef);
  return (
    <div className="flex flex-wrap gap-2">
      {onOpenReview && !ownerRead.completion ? (
        <ReviewArtifactButton ownerRead={ownerRead} onPrepared={(review) => onOpenReview(review, itemRef)} />
      ) : null}
      <button
        type="button"
        data-testid="product-schedule-open-artifact"
        data-open-ref={artifact.openInWorkspaceRef}
        disabled={loading}
        aria-busy={loading}
        className="shrink-0 rounded-lg bg-cafe-accent px-3 py-2 text-xs font-semibold text-[var(--cafe-accent-foreground)] hover:bg-cafe-accent-hover disabled:cursor-wait disabled:opacity-60"
        onClick={() => onOpenArtifact?.(artifact, itemRef, displayTitle)}
      >
        {loading ? '正在加载成果…' : '打开成果'}
      </button>
    </div>
  );
}
