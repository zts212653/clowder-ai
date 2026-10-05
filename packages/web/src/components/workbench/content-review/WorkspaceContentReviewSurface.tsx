'use client';
import { ContentReviewSurface } from './ContentReviewSurface';
import { useWorkspaceContentReview } from './useWorkspaceContentReview';

type Props = Omit<Parameters<typeof ContentReviewSurface>[0], 'review'> & { worktreeId: string };
export function WorkspaceContentReviewSurface({ worktreeId, ...props }: Props) {
  return <FileReviewSurface key={JSON.stringify([worktreeId, props.path])} worktreeId={worktreeId} {...props} />;
}
function FileReviewSurface({ worktreeId, ...props }: Props) {
  const review = useWorkspaceContentReview({ worktreeId, path: props.path });
  return <ContentReviewSurface {...props} review={review} />;
}
