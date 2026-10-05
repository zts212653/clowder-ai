'use client';
import type { EvolutionMediaLocator } from '@cat-cafe/shared';
import type { WorkspaceFileNavigationOrigin } from '@/stores/chat-types';
import { ContentReviewSurface } from './ContentReviewSurface';
import { useWorkspaceContentReview } from './useWorkspaceContentReview';

export function EvolutionContentReviewSurface(props: {
  locator: EvolutionMediaLocator;
  title: string;
  navigationOrigin?: WorkspaceFileNavigationOrigin;
  onBack(): void;
}) {
  const review = useWorkspaceContentReview({ evolution: props.locator });
  return (
    <ContentReviewSurface
      review={review}
      path={props.title}
      sourceText=""
      sourceTextRevision=""
      onBack={props.onBack}
      navigationOrigin={props.navigationOrigin}
      versionControl={<span className="text-xs text-cafe-muted">实验原件</span>}
    />
  );
}
