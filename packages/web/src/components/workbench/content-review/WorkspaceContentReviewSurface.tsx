'use client';
import type { ReactNode } from 'react';
import { useRetainedArtworkSource } from '@/components/content-review/ArtworkGalleryScope';
import { ContentReviewSurface } from './ContentReviewSurface';
import { useWorkspaceContentReview } from './useWorkspaceContentReview';

type Props = Omit<Parameters<typeof ContentReviewSurface>[0], 'review'> & {
  worktreeId: string;
  oversizedVideoReader?: (reason: string) => ReactNode;
};
export function WorkspaceContentReviewSurface({ worktreeId, ...props }: Props) {
  return <FileReviewSurface key={JSON.stringify([worktreeId, props.path])} worktreeId={worktreeId} {...props} />;
}
function FileReviewSurface({ worktreeId, oversizedVideoReader, ...props }: Props) {
  const reference = useRetainedArtworkSource();
  const retained =
    reference?.kind === 'workspace' &&
    reference.locator.worktreeId === worktreeId &&
    reference.locator.path === props.path
      ? { reviewId: reference.reviewId, revision: reference.expectedSourceRevision }
      : undefined;
  const review = useWorkspaceContentReview({ worktreeId, path: props.path, retained });
  if (!review.view && review.openingRefusal === 'too_large' && oversizedVideoReader)
    return oversizedVideoReader('这个文件太大，暂时无法批注或协作。');
  return <ContentReviewSurface {...props} review={review} />;
}
