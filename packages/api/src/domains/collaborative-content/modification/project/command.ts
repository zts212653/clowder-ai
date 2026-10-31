import type { VideoProjectCommand } from '@cat-cafe/shared';
import type { VideoProjectSelfReviewService } from '../../../video-studio/project/self-review.js';
import type { VideoProjectService } from '../../../video-studio/project/service.js';
import type { VideoProjectReviewService } from '../../workspace-review/video-project-review-service.js';
import { ModificationTextError } from '../text/text-store.js';
import { projectCommandJsonPage } from './json-page.js';
import type { ProjectMessageTakeoverService } from './service.js';
import type { ProjectCatPrincipal } from './types.js';
export interface ProjectCommandDeps {
  projects: VideoProjectService;
  reviews: VideoProjectReviewService;
  selfReviews: VideoProjectSelfReviewService;
  takeover: ProjectMessageTakeoverService;
  changed?: (ownerUserId: string, contentRef: string) => void;
}
/** The callback command consumes current journal/Task/source authority before every owner operation. */
export async function runProjectCommand(
  deps: ProjectCommandDeps,
  input: VideoProjectCommand,
  principal: ProjectCatPrincipal,
): Promise<unknown> {
  const record = await deps.takeover.authorizeCommand(input.requestId, principal);
  const source = record.payload.source;
  if (source.kind !== 'video-project') throw new ModificationTextError('not_found');
  const contentRef = source.contentRef,
    command = input.command;
  switch (command.kind) {
    case 'read': {
      const value = await deps.projects.load({
        principal,
        contentRef,
        ...(command.ownerRevision ? { ownerRevision: command.ownerRevision } : {}),
      });
      return projectCommandJsonPage(input.requestId, 'project-input', command, value);
    }
    case 'review-read': {
      const value = await deps.reviews.read({ principal, reviewId: source.reviewId });
      return projectCommandJsonPage(input.requestId, 'project-review', command, value);
    }
    case 'save': {
      if (!Object.hasOwn(command, 'document')) throw new ModificationTextError('invalid_patch');
      const receipt = await deps.projects.save({ ...command, principal, contentRef });
      deps.changed?.(principal.userId, contentRef);
      return { requestId: record.requestId, receipt };
    }
    case 'review-act': {
      if (!source.annotationIds.includes(command.action.annotationId)) throw new ModificationTextError('not_found');
      const result = await deps.reviews.act({ ...command, principal, reviewId: source.reviewId });
      deps.changed?.(principal.userId, contentRef);
      return {
        requestId: record.requestId,
        receipt: result.receipt,
        review: { reviewId: result.review.reviewId, revision: result.review.revision },
      };
    }
    case 'self-review': {
      const result = await deps.selfReviews.attest({ ...command, principal, contentRef });
      deps.changed?.(principal.userId, contentRef);
      return { requestId: record.requestId, ...result };
    }
  }
}
