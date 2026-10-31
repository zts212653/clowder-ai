import type { WorkspaceContentAnnotation, WorkspaceContentReview, WorkspaceContentSource } from '@cat-cafe/shared';
import type { VideoProjectPrincipal } from '../../../video-studio/project/access.js';
import { WorkspaceContentReviewError } from '../errors.js';

export function projectAudienceKey(principal: VideoProjectPrincipal) {
  // Scope survives CLI invocation and server restart; actor IDs cannot select another user's projection.
  return JSON.stringify([principal.userId, principal.actor.kind, principal.actor.actorId]);
}

/** The current F138 input is public project authority; an invisible first opinion never selects a Cat's default input. */
export function visibleProjectReview(
  original: WorkspaceContentReview,
  annotations: WorkspaceContentAnnotation[],
  currentSource: WorkspaceContentSource,
  createdAt: string,
): WorkspaceContentReview {
  const history = visibleSources(original, annotations, currentSource);
  return {
    ...original,
    annotations,
    source: currentSource,
    sourceHistory: history,
    createdAt,
    updatedAt: annotations.reduce((at, item) => (item.updatedAt > at ? item.updatedAt : at), createdAt),
  };
}

/** Retry invisible canonical contention, never a stale audience version or a reused operation. */
export class ProjectAudienceConflict extends WorkspaceContentReviewError {
  constructor() {
    super('revision_conflict');
  }
}

export async function retryProjectAudience<T>(
  principal: VideoProjectPrincipal,
  operation: () => Promise<T>,
): Promise<T> {
  if (principal.actor.kind === 'human') return operation();
  for (let attempt = 0; attempt < 8; attempt++) {
    try {
      return await operation();
    } catch (error) {
      if (
        !(error instanceof WorkspaceContentReviewError) ||
        error.code !== 'revision_conflict' ||
        error instanceof ProjectAudienceConflict
      )
        throw error;
      if (attempt === 7) throw new WorkspaceContentReviewError('version_pending');
    }
  }
  throw new WorkspaceContentReviewError('version_pending');
}

function sourceKey(source: WorkspaceContentSource) {
  return source.kind === 'video-project' ? `${source.ownerRevision}:${source.revision}` : source.revision;
}

function annotationVersions(annotation: WorkspaceContentAnnotation, revisions: Set<string>, owners: Set<number>) {
  const anchor = annotation.anchor;
  revisions.add(
    'kind' in anchor && anchor.kind === 'video-project'
      ? `${anchor.baseOwnerRevision}:${anchor.baseRevision}`
      : anchor.baseRevision,
  );
  for (const event of annotation.projectHistory ?? []) {
    for (const target of event.targets ?? []) revisions.add(`${target.baseOwnerRevision}:${target.baseRevision}`);
    const result = event.result;
    if (result && 'blobDigest' in result) revisions.add(`${result.ownerRevision}:${result.blobDigest}`);
    if (result && 'assetVersionRef' in result) owners.add(result.ownerRevision);
  }
}

function visibleSources(
  original: WorkspaceContentReview,
  annotations: WorkspaceContentAnnotation[],
  current: WorkspaceContentSource,
) {
  const revisions = new Set([sourceKey(current)]),
    owners = new Set<number>();
  for (const annotation of annotations) annotationVersions(annotation, revisions, owners);
  const history = new Map<string, WorkspaceContentSource>();
  for (const source of [...(original.sourceHistory ?? []), current])
    if (revisions.has(sourceKey(source)) || (source.kind === 'video-project' && owners.has(source.ownerRevision)))
      history.set(sourceKey(source), source);
  return [...history.values()].sort((left, right) => {
    if (left.kind === 'video-project' && right.kind === 'video-project' && left.ownerRevision !== right.ownerRevision)
      return left.ownerRevision - right.ownerRevision;
    const l = sourceKey(left),
      r = sourceKey(right);
    return l < r ? -1 : l > r ? 1 : 0;
  });
}
