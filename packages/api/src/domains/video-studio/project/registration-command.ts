import { videoProjectScreeningSchema, videoProjectSelfReviewSchema } from '@cat-cafe/shared';
import { ContentOwnerIdempotencyError, type ProjectContentOwnerService } from '../content-owner/service.js';
import type { VideoContentOperationContextV1 } from '../content-owner/types.js';
import { sameProjectValue } from './document-mutations.js';
import { validateScreeningAppend } from './registration-facts.js';
import type { AppendVideoProjectScreening } from './screening-types.js';
import type { AppendVideoProjectSelfReview } from './self-review.js';
import type { VideoProjectReadPort } from './types.js';

type ScreeningAppend = Parameters<AppendVideoProjectScreening>[0];
type SelfReviewAppend = Parameters<AppendVideoProjectSelfReview>[0];
type Registration =
  | { field: 'screenings'; fact: ScreeningAppend['screening'] }
  | { field: 'selfReviews'; fact: SelfReviewAppend['selfReview'] };

export async function prepareScreeningCommand(
  owner: ProjectContentOwnerService,
  projects: VideoProjectReadPort,
  input: ScreeningAppend,
) {
  const screening = videoProjectScreeningSchema.parse(input.screening);
  return prepare(projects, input, { field: 'screenings', fact: screening }, 'video-project:screening', () =>
    validateScreeningAppend(owner, projects, input, screening),
  );
}
export async function prepareSelfReviewCommand(projects: VideoProjectReadPort, input: SelfReviewAppend) {
  const fact = videoProjectSelfReviewSchema.parse(input.selfReview);
  return prepare(projects, input, { field: 'selfReviews', fact }, 'video-project:self-review', async () => {
    const frozen = await projects.load({ ...input, ownerRevision: fact.input.ownerRevision });
    if (
      input.principal.actor.kind !== 'cat' ||
      !input.principal.invocationId ||
      !sameProjectValue(fact.actor, input.principal.actor) ||
      fact.operationId !== input.operationId ||
      !fact.refs.includes(`invocation:${input.principal.invocationId}`) ||
      fact.input.contentRef !== input.contentRef ||
      fact.input.ownerRevision > input.expectedOwnerRevision ||
      fact.input.blobDigest !== frozen.blobDigest ||
      fact.segmentIds.some((id) => !frozen.document.timeline.segments.some((segment) => segment.id === id))
    )
      throw new TypeError('Self-review registration requires authenticated Cat, frozen input and actual segments');
  });
}
async function prepare(
  projects: VideoProjectReadPort,
  input: ScreeningAppend | SelfReviewAppend,
  registration: Registration,
  kind: VideoContentOperationContextV1['kind'],
  validate: () => Promise<void>,
) {
  const context: VideoContentOperationContextV1 = { kind, requestDigest: input.requestDigest };
  const receipt = await projects.operationReceipt(input);
  if (receipt) {
    const saved = await projects.load({ ...input, ownerRevision: receipt.ownerRevision });
    if (
      !sameProjectValue(receipt.operationContext, context) ||
      receipt.previousOwnerRevision !== input.expectedOwnerRevision ||
      !sameProjectValue(receipt.actor, input.principal.actor) ||
      !sameProjectValue(
        saved.document[registration.field]?.find((fact) => fact.operationId === input.operationId),
        registration.fact,
      )
    )
      throw new ContentOwnerIdempotencyError(input.contentRef, input.operationId);
    return { receipt, context, document: saved.document };
  }
  await validate();
  const base = await projects.load({ ...input, ownerRevision: input.expectedOwnerRevision });
  return {
    receipt: undefined,
    context,
    document: {
      ...base.document,
      [registration.field]: [...(base.document[registration.field] ?? []), registration.fact],
    },
  };
}
