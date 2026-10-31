import type {
  VideoProjectReviewAnchor,
  VideoProjectReviewSource,
  WorkspaceContentAnnotationResolution,
  WorkspaceContentReview,
  WorkspaceContentReviewView,
} from '@cat-cafe/shared';
import type { VideoProjectPrincipal } from '../../video-studio/project/access.js';
import type {
  VideoProjectReadPort as VideoProjectReviewPort,
  VideoProjectSnapshot,
} from '../../video-studio/project/types.js';
import { WorkspaceContentReviewError } from './errors.js';
import { visibleProjectReview } from './project-message/audience.js';
import type { ProjectAnnotationProjection } from './project-message/types.js';
import { resolveProjectAnchor } from './video-project-review-resolution.js';

export type {
  VideoProjectReadPort as VideoProjectReviewPort,
  VideoProjectSnapshot,
} from '../../video-studio/project/types.js';

export function videoProjectLedgerSource(snapshot: VideoProjectSnapshot): VideoProjectReviewSource {
  return {
    kind: 'video-project',
    contentRef: snapshot.contentRef,
    ownerRevision: snapshot.ownerRevision,
    revision: snapshot.blobDigest,
    mime: 'application/vnd.cat-cafe.video-project+json',
  };
}

export async function readVideoProjectReview(
  port: VideoProjectReviewPort | undefined,
  originalReview: WorkspaceContentReview,
  principal: VideoProjectPrincipal,
  projectAnnotation?: ProjectAnnotationProjection,
): Promise<WorkspaceContentReviewView> {
  const annotations = await Promise.all(
    originalReview.annotations.map((annotation) =>
      projectAnnotation
        ? projectAnnotation(annotation)
        : Promise.resolve(annotation.projectMessage ? undefined : annotation),
    ),
  );
  let review = { ...originalReview, annotations: annotations.filter((annotation) => annotation !== undefined) };
  if (!port || review.source.kind !== 'video-project') throw new WorkspaceContentReviewError('unsupported_content');
  if (review.ownerUserId !== principal.userId || review.source.contentRef !== review.contentRef)
    throw new WorkspaceContentReviewError('access_denied');
  const ledgerSource = review.source;
  const current = await port.load({ principal, contentRef: review.contentRef });
  if (principal.actor.kind === 'cat')
    review = visibleProjectReview(
      originalReview,
      review.annotations,
      videoProjectLedgerSource(current),
      current.document.origin.at,
    );
  const projectedSource = principal.actor.kind === 'cat' ? videoProjectLedgerSource(current) : ledgerSource;
  const sources = new Map<number, Promise<VideoProjectSnapshot>>();
  sources.set(current.ownerRevision, Promise.resolve(current));
  const load = (ownerRevision: number) => {
    let snapshot = sources.get(ownerRevision);
    if (!snapshot) {
      snapshot = port.load({ principal, contentRef: review.contentRef, ownerRevision });
      sources.set(ownerRevision, snapshot);
    }
    return snapshot;
  };
  const frozen = await load(projectedSource.ownerRevision);
  if (frozen.blobDigest !== projectedSource.revision) throw new WorkspaceContentReviewError('source_changed');
  const annotationResolutions: WorkspaceContentAnnotationResolution[] = await Promise.all(
    review.annotations.map(async (annotation) => {
      if (!('kind' in annotation.anchor) || annotation.anchor.kind !== 'video-project')
        return { annotationId: annotation.id, status: 'orphaned' as const };
      const anchor = annotation.anchor;
      const targets = new Map<string, VideoProjectReviewAnchor>();
      for (const target of [anchor, ...(annotation.projectHistory ?? []).flatMap((event) => event.targets ?? [])])
        targets.set(JSON.stringify(target), target);
      const projectTargets = await Promise.all(
        [...targets.values()].map(async (target) => {
          const original = await load(target.baseOwnerRevision);
          if (original.blobDigest !== target.baseRevision) throw new WorkspaceContentReviewError('source_changed');
          return { anchor: target, status: resolveProjectAnchor(target, original, current) };
        }),
      );
      return { annotationId: annotation.id, status: projectTargets[0]?.status ?? 'orphaned', projectTargets };
    }),
  );
  const currentSource = videoProjectLedgerSource(current);
  const sourceState =
    current.ownerRevision === projectedSource.ownerRevision && current.blobDigest === projectedSource.revision
      ? 'current'
      : 'changed';
  let writeAuthorized = false;
  if (!current.document.archivedAt) {
    try {
      await port.authorize({ principal, contentRef: review.contentRef, permission: 'write' });
      writeAuthorized = true;
    } catch {
      // Reading succeeded; any failed write-authority probe closes editing/reply capability and grants nothing.
    }
  }
  // Owner reads/resolution may await after the first source permission check. Narrow again at disclosure.
  const visible = await confirmProjectAnnotations(review, projectAnnotation);
  review =
    principal.actor.kind === 'cat'
      ? visibleProjectReview(originalReview, visible, currentSource, current.document.origin.at)
      : { ...review, annotations: visible };
  const visibleIds = new Set(visible.map((annotation) => annotation.id));
  return {
    review,
    currentSource,
    sourceState,
    annotationResolutions: annotationResolutions.filter((resolution) => visibleIds.has(resolution.annotationId)),
    canReply: writeAuthorized,
    canWrite: sourceState === 'current' && writeAuthorized,
    historyReadOnly: sourceState !== 'current' || Boolean(current.document.archivedAt),
  };
}

async function confirmProjectAnnotations(
  review: WorkspaceContentReview,
  projectAnnotation?: ProjectAnnotationProjection,
) {
  if (!projectAnnotation) return review.annotations;
  const confirmed = await Promise.all(review.annotations.map((annotation) => projectAnnotation(annotation)));
  return confirmed.filter((annotation) => annotation !== undefined);
}
