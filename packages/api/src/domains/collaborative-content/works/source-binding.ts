import type { WorkReference, WorkVideoContext } from '@cat-cafe/shared';
import { MediaOwnerError } from '../../video-studio/content-owner/media-errors.js';
import type { VideoProjectScreeningService } from '../../video-studio/project/screening-service.js';
import type { VideoProjectReadPort, VideoProjectSnapshot } from '../../video-studio/project/types.js';
import type { VideoProjectReviewService } from '../workspace-review/video-project-review-service.js';
import type { WorkPrincipal } from './service.js';

export type WorkSourceBinding = NonNullable<WorkVideoContext['sourceBinding']>;
export type VerifyWorkSourceBinding = (
  reference: WorkReference,
  binding: WorkSourceBinding,
  principal: WorkPrincipal,
) => Promise<void>;

/** The work writer does not acquire source-project or original-opinion authority by supplying their IDs. */
export function createWorkSourceBindingVerifier(deps: {
  projects: Pick<VideoProjectReadPort, 'load' | 'authorize'>;
  screenings: Pick<VideoProjectScreeningService, 'descriptor'>;
  reviews?: Pick<VideoProjectReviewService, 'read'>;
  workDigest(reference: WorkReference, principal: WorkPrincipal): Promise<string>;
}): VerifyWorkSourceBinding {
  return async (reference, binding, principal) => {
    const project = await deps.projects.load({
      principal,
      contentRef: binding.sourceProjectContentRef,
      ownerRevision: binding.sourceOwnerRevision,
    });
    assertSourceProject(binding, project);
    if (binding.screeningId) {
      const { screening } = await deps.screenings.descriptor({
        principal,
        contentRef: project.contentRef,
        screeningId: binding.screeningId,
      });
      if (
        screening.id !== binding.screeningId ||
        screening.input.contentRef !== project.contentRef ||
        screening.input.ownerRevision !== project.ownerRevision ||
        screening.input.blobDigest !== project.blobDigest ||
        screening.media.blobDigest !== (await deps.workDigest(reference, principal))
      )
        throw new MediaOwnerError('publication_changed');
    }
    if (binding.reviewId) {
      if (!deps.reviews) throw new MediaOwnerError('access_denied');
      // Reuse the original audience projection, never inspect a raw ledger or impersonate its Human owner.
      const { review } = await deps.reviews.read({ principal, reviewId: binding.reviewId });
      if (
        review.reviewId !== binding.reviewId ||
        review.source.kind !== 'video-project' ||
        review.contentRef !== project.contentRef
      )
        throw new MediaOwnerError('publication_changed');
    }
    await deps.projects.authorize({ principal, contentRef: project.contentRef, permission: 'read' });
  };
}

function assertSourceProject(binding: WorkSourceBinding, project: VideoProjectSnapshot) {
  if (
    project.contentRef !== binding.sourceProjectContentRef ||
    project.ownerRevision !== binding.sourceOwnerRevision ||
    project.blobDigest !== binding.sourceDigest
  )
    throw new MediaOwnerError('publication_changed');
}
