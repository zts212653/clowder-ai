import { createHash } from 'node:crypto';
import type {
  ReviewedMediaAsset,
  WorkspaceContentReview,
  WorkspaceContentReviewView,
  WorkspaceContentSource,
} from '@cat-cafe/shared';
import { MediaOwnerError } from '../../video-studio/content-owner/media-errors.js';
import type { MediaReviewPrincipal } from '../../video-studio/content-owner/published-media-access.js';
import type { PublishedMediaService } from '../../video-studio/content-owner/published-media-service.js';
import { ContentOwnerNotFoundError } from '../../video-studio/content-owner/service.js';
import { WorkspaceContentReviewError } from './errors.js';
import type { WorkspaceReviewPrincipal } from './service.js';
import {
  resolveMediaWorkspaceReviewAnnotations,
  resolveWorkspaceReviewVisualMarks,
} from './workspace-review-annotation-resolution.js';

export interface PublicationReviewTarget {
  readonly contentRef: string;
  readonly ownerRevision: number;
}
export type PublicationReviewPort = Pick<PublishedMediaService, 'read' | 'currentRevision'>;

function humanPrincipal(principal: WorkspaceReviewPrincipal): MediaReviewPrincipal {
  if (principal.actor.kind !== 'human' || principal.actor.actorId !== principal.userId)
    throw new WorkspaceContentReviewError('access_denied');
  return { userId: principal.userId, actor: principal.actor };
}

export function publicationLedgerSource(
  asset: ReviewedMediaAsset,
): Extract<WorkspaceContentSource, { kind: 'publication' }> {
  const { media, mediaType, ...publication } = asset;
  return {
    kind: 'publication',
    media,
    mime: mediaType,
    publication,
    revision: `sha256:${createHash('sha256')
      .update(JSON.stringify([asset.contentRef, asset.ownerRevision]))
      .digest('hex')}`,
  };
}

export async function resolvePublicationReviewSource(
  port: PublicationReviewPort | undefined,
  target: PublicationReviewTarget,
  principal: WorkspaceReviewPrincipal,
) {
  if (!port) throw new WorkspaceContentReviewError('unsupported_content');
  try {
    const asset = await port.read(target.contentRef, target.ownerRevision, humanPrincipal(principal));
    return { contentRef: `${asset.contentRef}#version:${asset.ownerRevision}`, source: publicationLedgerSource(asset) };
  } catch (error) {
    if (error instanceof MediaOwnerError && error.code === 'access_denied')
      throw new WorkspaceContentReviewError('access_denied');
    // A publication this owner store does not hold is a definite answer, not an unknown failure.
    if (error instanceof ContentOwnerNotFoundError || (error instanceof MediaOwnerError && error.code === 'not_found'))
      throw new WorkspaceContentReviewError('not_found');
    throw error;
  }
}

export async function readPublicationReview(
  port: PublicationReviewPort | undefined,
  review: WorkspaceContentReview,
  principal: WorkspaceReviewPrincipal,
): Promise<WorkspaceContentReviewView> {
  if (!port || review.source.kind !== 'publication') throw new WorkspaceContentReviewError('unsupported_content');
  const resolved = await resolvePublicationReviewSource(port, review.source.publication, principal);
  if (resolved.contentRef !== review.contentRef || resolved.source.revision !== review.source.revision)
    throw new WorkspaceContentReviewError('source_unavailable');
  const currentRevision = await port.currentRevision(review.source.publication.contentRef, humanPrincipal(principal));
  const historyReadOnly = currentRevision !== review.source.publication.ownerRevision;
  return {
    review,
    sourceState: 'current',
    currentSource: resolved.source,
    canWrite: !historyReadOnly,
    canReply: true,
    historyReadOnly,
    annotationResolutions: resolveMediaWorkspaceReviewAnnotations(review, resolved.source),
    visualMarkResolutions: resolveWorkspaceReviewVisualMarks(review, resolved.source),
  };
}
