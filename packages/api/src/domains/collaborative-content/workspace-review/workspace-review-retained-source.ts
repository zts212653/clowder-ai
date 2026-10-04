import type { WorkspaceContentReview } from '@cat-cafe/shared';
import type { WorkspaceContentSourceService } from '../../workspace/workspace-content-source.js';
import { WorkspaceContentReviewError } from './errors.js';
import { type EvolutionMediaReadPort, readEvolutionReview } from './evolution-review-source.js';
import { type PublicationReviewPort, readPublicationReview } from './publication-review-source.js';
import type { WorkspaceReviewPrincipal } from './service.js';
import type { WorkspaceContentReviewStore } from './store.js';
import { assertWorkspaceReviewHuman } from './workspace-review-anchors.js';

/** Internal task-delegated evidence read. No HTTP action accepts the verifier; mutation APIs remain human-only. */
export async function readRetainedWorkspaceRevision(
  owners: Parameters<typeof readRetainedWorkspaceReview>[0] & { store: WorkspaceContentReviewStore },
  input: { principal: WorkspaceReviewPrincipal; reviewId: string; revision: number },
  authorizeTask?: () => Promise<void>,
): Promise<WorkspaceContentReview> {
  if (authorizeTask) await authorizeTask();
  else assertWorkspaceReviewHuman(input.principal);
  const current = owners.store.get(input.reviewId);
  if (!current) throw new WorkspaceContentReviewError('not_found');
  if (current.ownerUserId !== input.principal.userId) throw new WorkspaceContentReviewError('access_denied');
  const retained = owners.store.retained.get(input.reviewId, input.revision);
  if (!retained) throw new WorkspaceContentReviewError('not_found');
  const result = await readRetainedWorkspaceReview(owners, input.principal, retained);
  if (authorizeTask) await authorizeTask();
  return result;
}

export async function readRetainedWorkspaceReview(
  owners: {
    source: WorkspaceContentSourceService;
    publications?: PublicationReviewPort;
    evolution?: EvolutionMediaReadPort;
  },
  principal: WorkspaceReviewPrincipal,
  retained: WorkspaceContentReview,
): Promise<WorkspaceContentReview> {
  if (retained.source.kind === 'publication') await readPublicationReview(owners.publications, retained, principal);
  else if (retained.source.kind === 'evolution') await readEvolutionReview(owners.evolution, retained, principal);
  else {
    const current = await owners.source.describe({
      principal: { userId: principal.userId },
      locator: retained.source.locator,
    });
    if (current.contentRef !== retained.contentRef) throw new WorkspaceContentReviewError('access_denied');
  }
  return retained;
}
