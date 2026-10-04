import type { WorkspaceSurfaceDescriptor } from './workbench-contract';

const reviewIdPattern = /^review-[a-f0-9]{64}$/;
export function createArtifactReviewSurface(
  reviewId: string,
  threadId: string,
  title = '产物审阅',
  round?: number,
): WorkspaceSurfaceDescriptor {
  if (!reviewIdPattern.test(reviewId) || !threadId || threadId.includes('\0'))
    throw new Error('Invalid content review owner coordinates');
  if (round !== undefined && (!Number.isSafeInteger(round) || round < 1)) throw new Error('Invalid review round');
  return {
    id: `content-review:${reviewId}`,
    type: 'review',
    renderer: 'review-summary',
    title,
    context: '一起审阅 · 原任务',
    objectRef: { kind: 'review', id: reviewId },
    ownerStateRef: {
      owner: 'f309-content-review',
      key: round === undefined ? reviewId : JSON.stringify({ reviewId, round }),
    },
    resultTargetRef: { owner: 'thread', key: threadId },
    capabilities: { split: true, sidecar: true, pin: true, closePolicy: 'detach-host', restorePolicy: 'descriptor' },
  };
}
export function resolveArtifactReviewTarget(
  surface: WorkspaceSurfaceDescriptor,
): { reviewId: string; threadId: string; round?: number } | null {
  if (
    surface.type !== 'review' ||
    surface.renderer !== 'review-summary' ||
    surface.objectRef.kind !== 'review' ||
    !reviewIdPattern.test(surface.objectRef.id) ||
    surface.id !== `content-review:${surface.objectRef.id}` ||
    surface.ownerStateRef.owner !== 'f309-content-review' ||
    surface.resultTargetRef?.owner !== 'thread' ||
    !surface.resultTargetRef.key
  )
    return null;
  if (surface.ownerStateRef.key === surface.objectRef.id)
    return { reviewId: surface.objectRef.id, threadId: surface.resultTargetRef.key };
  try {
    const selection = JSON.parse(surface.ownerStateRef.key) as { reviewId?: unknown; round?: unknown };
    if (
      Object.keys(selection).sort().join(',') !== 'reviewId,round' ||
      selection.reviewId !== surface.objectRef.id ||
      typeof selection.round !== 'number' ||
      !Number.isSafeInteger(selection.round) ||
      selection.round < 1
    )
      return null;
    return { reviewId: surface.objectRef.id, threadId: surface.resultTargetRef.key, round: selection.round };
  } catch {
    return null;
  }
}
/** `title` is the review's own title when the caller already knows it; the tab otherwise stays generic. */
export function reviewSurfaceFromPreparedRef(ref: string, title?: string): WorkspaceSurfaceDescriptor | null {
  const match = /^workspace:content-review:([^:]+):(review-[a-f0-9]{64})$/.exec(ref);
  return match?.[1] && match[2] ? createArtifactReviewSurface(match[2], match[1], title) : null;
}
export function reviewSurfaceFromActionRef(ref: string, threadId: string): WorkspaceSurfaceDescriptor | null {
  const match = /^content-review:(review-[a-f0-9]{64})$/.exec(ref);
  return match?.[1] ? createArtifactReviewSurface(match[1], threadId) : null;
}
