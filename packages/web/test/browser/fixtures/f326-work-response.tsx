import { useState } from 'react';
import { createRoot } from 'react-dom/client';
import '@/app/theme-tokens.css';
import '@/app/console-tokens.css';
import '@/app/console-controls.css';
import '@/app/globals.css';
import { ArtifactReviewSurface } from '@/components/content-review/ArtifactReviewSurface';
import { resolveArtifactReviewTarget } from '@/components/workbench/artifact-review-surface';
import { PublicationContentReviewSurface } from '@/components/workbench/content-review/PublicationContentReviewSurface';
import { PublicationLandingResolver } from '@/components/workbench/PublicationLandingResolver';
import { createPublicationSurface } from '@/components/workbench/publication-surface';
import { WorkspaceSurfaceVisibilityProvider } from '@/components/workbench/WorkspaceSurfaceVisibility';
import type { WorkspaceSurfaceDescriptor } from '@/components/workbench/workbench-contract';
import { useChatStore } from '@/stores/chatStore';

const query = new URLSearchParams(location.search);
useChatStore.setState({ currentThreadId: query.get('threadId') ?? undefined });
const root = document.getElementById('root');
if (!root) throw new Error('fixture root required');
function WorkEntry() {
  const target = { contentRef: query.get('contentRef') ?? '', ownerRevision: Number(query.get('ownerRevision')) };
  const [navigation, setNavigation] = useState<WorkspaceSurfaceDescriptor | null>(null);
  const review = navigation && resolveArtifactReviewTarget(navigation);
  if (review)
    return (
      <ArtifactReviewSurface
        reviewId={review.reviewId}
        initialRound={review.round}
        onBack={() => setNavigation(null)}
      />
    );
  return (
    <PublicationLandingResolver
      sourceSurface={createPublicationSurface({ ...target, title: '回应原意见的同一部作品' })}
      target={target}
      onResolved={setNavigation}
      onBack={() => history.back()}
    >
      <PublicationContentReviewSurface {...target} title="回应原意见的同一部作品" onBack={() => history.back()} />
    </PublicationLandingResolver>
  );
}
createRoot(root).render(
  <main style={{ height: '100vh', display: 'flex' }}>
    <WorkspaceSurfaceVisibilityProvider visible>
      <WorkEntry />
    </WorkspaceSurfaceVisibilityProvider>
  </main>,
);
