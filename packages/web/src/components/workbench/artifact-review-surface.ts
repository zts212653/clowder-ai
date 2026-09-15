import type { WorkspaceSurfaceDescriptor } from './workbench-contract';

const reviewIdPattern = /^review-[a-f0-9]{64}$/;
export function createArtifactReviewSurface(
  reviewId: string,
  threadId: string,
  title = '产物审阅',
): WorkspaceSurfaceDescriptor {
  if (!reviewIdPattern.test(reviewId) || !threadId || threadId.includes('\0'))
    throw new Error('Invalid content review owner coordinates');
  return {
    id: `content-review:${reviewId}`,
    type: 'review',
    renderer: 'review-summary',
    title,
    context: '一起审阅 · 原任务',
    objectRef: { kind: 'review', id: reviewId },
    ownerStateRef: { owner: 'f309-content-review', key: reviewId },
    resultTargetRef: { owner: 'thread', key: threadId },
    capabilities: { split: true, sidecar: true, pin: true, closePolicy: 'detach-host', restorePolicy: 'descriptor' },
  };
}
export function resolveArtifactReviewTarget(
  surface: WorkspaceSurfaceDescriptor,
): { reviewId: string; threadId: string } | null {
  if (
    surface.type !== 'review' ||
    surface.renderer !== 'review-summary' ||
    surface.objectRef.kind !== 'review' ||
    !reviewIdPattern.test(surface.objectRef.id) ||
    surface.id !== `content-review:${surface.objectRef.id}` ||
    surface.ownerStateRef.owner !== 'f309-content-review' ||
    surface.ownerStateRef.key !== surface.objectRef.id ||
    surface.resultTargetRef?.owner !== 'thread' ||
    !surface.resultTargetRef.key
  )
    return null;
  return { reviewId: surface.objectRef.id, threadId: surface.resultTargetRef.key };
}
export function reviewSurfaceFromPreparedRef(ref: string): WorkspaceSurfaceDescriptor | null {
  const match = /^workspace:content-review:([^:]+):(review-[a-f0-9]{64})$/.exec(ref);
  return match?.[1] && match[2] ? createArtifactReviewSurface(match[2], match[1]) : null;
}
export function reviewSurfaceFromActionRef(ref: string, threadId: string): WorkspaceSurfaceDescriptor | null {
  const match = /^content-review:(review-[a-f0-9]{64})$/.exec(ref);
  return match?.[1] ? createArtifactReviewSurface(match[1], threadId) : null;
}
