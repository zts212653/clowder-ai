import {
  type ArtifactReviewCommand,
  type ArtifactReviewView,
  artifactReviewActorSchema,
  artifactReviewSchema,
} from '@cat-cafe/shared';
import { z } from 'zod';

const receiptSchema = z.object({
  reviewId: z.string(),
  operationId: z.string(),
  outcome: z.literal('applied'),
  revision: z.number().int().positive().safe(),
  receiptRef: z.string().min(1),
  actor: artifactReviewActorSchema,
  createdAt: z.string().datetime(),
});
const viewSchema = z.object({
  review: artifactReviewSchema,
  pendingVersion: z.boolean(),
  authority: z.object({
    state: z.enum(['current', 'task_changed', 'task_closed', 'asset_changed']),
    taskRevision: z.number().int().positive().safe(),
    ownerCatId: z.string().nullable(),
    canWrite: z.boolean(),
  }),
  continuation: z.object({
    taskId: z.string(),
    expectedRevision: z.number().int().positive().safe(),
    artifactRef: z.string(),
    reviewEvidenceRef: z.string(),
    ownerCatId: z.string().nullable(),
  }),
});

/** The POST may outlive its reader, but it only acknowledges this command and original owner. */
export function appliedReviewView(
  body: { view?: ArtifactReviewView; receipt?: unknown },
  command: ArtifactReviewCommand,
  original: ArtifactReviewView,
): ArtifactReviewView | null {
  const receipt = receiptSchema.safeParse(body?.receipt);
  const view = viewSchema.safeParse(body?.view);
  if (!receipt.success || !view.success || !body.view) return null;
  const acknowledged = receipt.data;
  const candidate = view.data.review;
  const source = original.review;
  if (
    acknowledged.reviewId !== command.reviewId ||
    acknowledged.operationId !== command.operationId ||
    acknowledged.revision !== command.expectedRevision + 1 ||
    candidate.reviewId !== command.reviewId ||
    candidate.revision < acknowledged.revision ||
    candidate.contentRef !== source.contentRef ||
    candidate.task.ownerUserId !== source.task.ownerUserId ||
    candidate.task.taskId !== source.task.taskId ||
    candidate.task.threadId !== source.task.threadId
  )
    return null;
  return body.view;
}
