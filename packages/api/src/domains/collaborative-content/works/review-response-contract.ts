import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { immutableMediaSchema, submitWorkSchema, workReviewResponseSchema } from '@cat-cafe/shared';
import { z } from 'zod';
import { ArtifactReviewError } from '../artifact-review/errors.js';
import type { PendingReviewVersion } from '../artifact-review/store.js';

/** Internal server-accepted input. Neither the public command nor a source path can supply these facts. */
export const acceptedWorkResponseSchema = z
  .object({
    kind: z.literal('work-submit-response'),
    command: submitWorkSchema.extend({ reviewResponse: workReviewResponseSchema }),
    ownerUserId: z.string().min(1),
    threadId: z.string().min(1),
    requestDigest: z.string().regex(/^sha256:[a-f0-9]{64}$/),
    blobDigest: z.string().regex(/^sha256:[a-f0-9]{64}$/),
    media: immutableMediaSchema,
    publication: z
      .object({ artifactRef: z.string(), sourceRef: z.string(), revision: z.string(), threadId: z.string().optional() })
      .strict(),
  })
  .strict();
export type AcceptedWorkResponse = z.infer<typeof acceptedWorkResponseSchema>;
export function readAcceptedWorkResponse(pending: PendingReviewVersion) {
  const accepted = acceptedWorkResponseSchema.parse(pending.payload);
  const { command } = accepted;
  const response = command.reviewResponse;
  if (
    pending.input.actor.kind !== 'cat' ||
    pending.input.kind !== 'work_submit_response' ||
    pending.input.operationId !== command.operationId ||
    pending.input.reviewId !== response.reviewId ||
    pending.input.round !== response.sourceRound ||
    pending.input.expectedRevision !== response.expectedReviewRevision ||
    !isDeepStrictEqual(pending.input.request, command) ||
    accepted.requestDigest !== `sha256:${createHash('sha256').update(JSON.stringify(command)).digest('hex')}`
  )
    throw new ArtifactReviewError('operation_reused');
  return { ...accepted, actor: pending.input.actor };
}
export function isWorkResponseIntent(value: unknown): boolean {
  return value !== null && typeof value === 'object' && 'kind' in value && value.kind === 'work-submit-response';
}
