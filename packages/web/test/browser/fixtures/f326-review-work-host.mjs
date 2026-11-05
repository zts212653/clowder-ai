import {
  createWorkAuthorizer,
  workMediaPrincipal,
} from '../../../../api/src/domains/collaborative-content/works/access.ts';
import { WorkReviewResponseService } from '../../../../api/src/domains/collaborative-content/works/review-response.ts';
import { createWorkResponseAuthority } from '../../../../api/src/domains/collaborative-content/works/review-response-authority.ts';
import { LivingWorkService } from '../../../../api/src/domains/collaborative-content/works/service.ts';
import { WorkVideoContextService } from '../../../../api/src/domains/collaborative-content/works/video-context.ts';
import { createWorkWorkspaceSource } from '../../../../api/src/domains/collaborative-content/works/workspace-source.ts';
import { withContentTask } from '../../../../api/src/domains/video-studio/content-owner/published-media-access.ts';
import { registerLivingWorkRoutes } from '../../../../api/src/routes/living-work-routes.ts';

/** Private authenticated fixture composition of the same Work/response owners and routes as index.ts.
 * The fixture creates the invocation; it is not a real director/model or C5 proof. No source-project binding is fabricated.
 */
export async function registerReviewWorkFixture({ app, fixture: f, workspace, registry }) {
  const responses = new WorkReviewResponseService({
    owner: f.owner,
    store: f.store,
    onCommitted: async (reviewId) => {
      await f.reviews.projectCommitted(reviewId);
      await f.changed('operator', reviewId);
    },
    authorize: createWorkResponseAuthority({ store: f.store, media: f.media, messages: f.messages }),
    readAsset: (review, revision, principal) =>
      f.media.read(review.contentRef, revision, withContentTask(workMediaPrincipal(principal), review.task.taskId)),
  });
  f.reviews.setWorkResponseRecovery((review, principal) =>
    responses.recover(review, { ...principal, threadId: principal.threadId ?? review.task.threadId }),
  );
  const service = new LivingWorkService({
    responses,
    owner: f.owner,
    versions: f.store.works,
    source: createWorkWorkspaceSource(workspace),
    authorize: createWorkAuthorizer({
      ownerUserId: 'operator',
      access: f.media.access,
      invocation: (id) => registry.peekRecord(id),
    }),
  });
  const contexts = new WorkVideoContextService({
    store: f.store.works.contexts,
    authorize: (ref, principal, permission) => service.authorizeVersion(ref, principal, permission),
    media: async (ref, principal) =>
      (await f.media.read(ref.contentRef, ref.ownerRevision, workMediaPrincipal(principal))).media,
  });
  await registerLivingWorkRoutes(app, { service, contexts, registry });
}
