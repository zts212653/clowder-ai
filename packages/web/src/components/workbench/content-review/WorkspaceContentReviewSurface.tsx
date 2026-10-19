'use client';
import { useArtworkReference } from '@/components/content-review/ArtworkGalleryScope';
import { ContentReviewSurface } from './ContentReviewSurface';
import { useWorkspaceContentReview } from './useWorkspaceContentReview';

type Props = Omit<Parameters<typeof ContentReviewSurface>[0], 'review'> & { worktreeId: string };
export function WorkspaceContentReviewSurface({ worktreeId, ...props }: Props) {
  return <FileReviewSurface key={JSON.stringify([worktreeId, props.path])} worktreeId={worktreeId} {...props} />;
}
function FileReviewSurface({ worktreeId, ...props }: Props) {
  const reference = useArtworkReference()?.attachment.source;
  const retained =
    reference?.kind === 'workspace' &&
    reference.locator.worktreeId === worktreeId &&
    reference.locator.path === props.path
      ? { reviewId: reference.reviewId, revision: reference.expectedSourceRevision }
      : undefined;
  const review = useWorkspaceContentReview({ worktreeId, path: props.path, retained });
  return <ContentReviewSurface {...props} review={review} />;
}
