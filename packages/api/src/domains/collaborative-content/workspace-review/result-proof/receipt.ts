import type {
  VideoProjectReviewResult,
  VideoProjectReviewSource,
  WorkspaceContentAnnotation,
  WorkspaceContentReview,
} from '@cat-cafe/shared';
import type { VideoProjectPrincipal } from '../../../video-studio/project/access.js';
import type { VideoProjectReadPort as VideoProjectReviewPort } from '../../../video-studio/project/types.js';
import { WorkspaceContentReviewError } from '../errors.js';
import { assertMessageResultLocation } from '../project-message/validation.js';
import { effectiveProjectReviewTargets } from '../video-project-review-actions.js';
import { videoProjectLedgerSource } from '../video-project-review-source.js';
import { assertProjectTargetChanged } from './target.js';
export async function validateProjectReviewResult(
  projects: VideoProjectReviewPort,
  review: WorkspaceContentReview,
  annotation: WorkspaceContentAnnotation,
  result: VideoProjectReviewResult,
  principal: VideoProjectPrincipal,
): Promise<VideoProjectReviewSource | undefined> {
  if ('kind' in result) return; // Explicit not-changed results carry a nonblank reason in the schema.
  const targets = effectiveProjectReviewTargets(annotation);
  assertMessageResultLocation(annotation, targets);
  const snapshot = await projects.load({
    principal,
    contentRef: review.contentRef,
    ownerRevision: result.ownerRevision,
  });
  if ('contentRef' in result) {
    if (result.contentRef !== review.contentRef || result.blobDigest !== snapshot.blobDigest)
      throw new WorkspaceContentReviewError('invalid_action');
    const receipt = await projects.operationReceipt({
      principal,
      contentRef: review.contentRef,
      operationId: result.operationId,
    });
    if (
      !receipt ||
      receipt.contentRef !== result.contentRef ||
      receipt.ownerRevision !== result.ownerRevision ||
      receipt.blobDigest !== result.blobDigest
    )
      throw new WorkspaceContentReviewError('invalid_action');
  }
  // One addressed event claims the whole effective set. Partial work uses not-changed + reason.
  for (const anchor of targets) {
    if (result.ownerRevision <= anchor.baseOwnerRevision) throw new WorkspaceContentReviewError('invalid_action');
    const original = await projects.load({
      principal,
      contentRef: review.contentRef,
      ownerRevision: anchor.baseOwnerRevision,
    });
    if (original.blobDigest !== anchor.baseRevision) throw new WorkspaceContentReviewError('source_changed');
    assertProjectTargetChanged(
      original.document,
      snapshot.document,
      anchor.target,
      'assetVersionRef' in result ? result.assetVersionRef : undefined,
    );
  }
  return videoProjectLedgerSource(snapshot);
}
