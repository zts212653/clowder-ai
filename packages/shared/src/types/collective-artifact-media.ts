import { z } from 'zod';
import { artifactReviewAnchorSchema } from './artifact-review-media.js';

const id = z.string().trim().min(1).max(256);
const body = z.string().trim().min(1).max(8000);
export const collectiveMediaShareScopeSchema = z
  .object({
    serviceInstanceId: id,
    collectiveId: id,
    artifactId: id,
    sourceEventId: id,
    custodyRevision: z.number().int().positive().safe(),
  })
  .strict();
export type CollectiveMediaShareScope = z.infer<typeof collectiveMediaShareScopeSchema>;

/** Authenticated Human review metadata. Media never accepts text patches, markup, adoption, or private locators. */
export const collectiveMediaReviewCommandSchema = z
  .object({
    kind: z.literal('media-review'),
    expectedReviewRevision: z.number().int().positive().safe(),
    action: z.discriminatedUnion('kind', [
      z.object({ kind: z.literal('annotate'), anchor: artifactReviewAnchorSchema, body }).strict(),
      z.object({ kind: z.literal('reply'), annotationId: id, body }).strict(),
      z.object({ kind: z.literal('edit_annotation'), annotationId: id, body }).strict(),
      z.object({ kind: z.literal('edit_reply'), annotationId: id, replyId: id, body }).strict(),
      z
        .object({ kind: z.literal('set_annotation_state'), annotationId: id, state: z.enum(['open', 'resolved']) })
        .strict(),
    ]),
  })
  .strict();
export type CollectiveMediaReviewCommand = z.infer<typeof collectiveMediaReviewCommandSchema>;

/** The retained owner scopes every idempotency receipt to the authenticated actor, Artifact and action. */
export async function collectiveMediaOperationId(
  scope: {
    serviceInstanceId: string;
    collectiveId: string;
    artifactId: string;
    humanId: string;
  },
  action: string,
  requestId: string,
) {
  const bytes = new TextEncoder().encode(
    JSON.stringify([scope.serviceInstanceId, scope.collectiveId, scope.artifactId, scope.humanId, action, requestId]),
  );
  const hash = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
  return `collective-media-operation:${Array.from(hash, (item) => item.toString(16).padStart(2, '0')).join('')}`;
}
