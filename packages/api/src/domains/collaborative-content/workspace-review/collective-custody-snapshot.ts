import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import {
  COLLECTIVE_CUSTODY_MAX_BYTES,
  type WorkspaceContentReview,
  type WorkspaceContentReviewReceipt,
  workspaceContentActorSchema,
  workspaceContentReviewSchema,
} from '@cat-cafe/shared';
import { z } from 'zod';
import { workspaceReviewIdentity } from './workspace-review-anchors.js';

const id = z.string().min(1).max(256);
const positive = z.number().int().positive().safe();
const receipt = z
  .object({
    receiptRef: z.string().min(1).max(512),
    reviewId: id,
    operationId: id,
    revision: positive,
    actor: workspaceContentActorSchema,
    createdAt: z.string().datetime(),
    replayed: z.literal(false),
  })
  .strict();
const operation = z.object({
  operationId: id,
  fingerprint: z.string().regex(/^[a-f0-9]{64}$/),
  receipt,
});
type CollectiveOperation = {
  operationId: string;
  fingerprint: string;
  receipt: Omit<WorkspaceContentReviewReceipt, 'preparationSource'>;
} & (
  | { generation: 'legacy'; revision: number }
  | { generation: 'result'; review: WorkspaceContentReview }
  | { generation: 'receipt'; resultRevision: number }
);
export interface CollectiveWorkspaceSnapshot {
  v: 1;
  review: WorkspaceContentReview;
  operations: CollectiveOperation[];
  retained: WorkspaceContentReview[];
}
const snapshotSchema: z.ZodType<CollectiveWorkspaceSnapshot> = z
  .object({
    v: z.literal(1),
    review: workspaceContentReviewSchema,
    operations: z
      .array(
        z.discriminatedUnion('generation', [
          operation.extend({ generation: z.literal('legacy'), revision: positive }).strict(),
          operation.extend({ generation: z.literal('result'), review: workspaceContentReviewSchema }).strict(),
          operation.extend({ generation: z.literal('receipt'), resultRevision: positive }).strict(),
        ]),
      )
      .min(1)
      .max(10000),
    retained: z.array(workspaceContentReviewSchema).max(10000),
  })
  .strict();

/** Keep each persisted receipt generation; reconstructing mutations would change replay and history. */
export function validateCollectiveWorkspaceSnapshot(
  unsafe: unknown,
  scopeRef: string,
  contentRef: string,
): CollectiveWorkspaceSnapshot {
  const encoded = JSON.stringify(unsafe);
  if (typeof encoded !== 'string' || Buffer.byteLength(encoded) > COLLECTIVE_CUSTODY_MAX_BYTES)
    throw new Error('Collective ledger exceeds its admitted bound');
  const snapshot = snapshotSchema.parse(unsafe);
  const review = snapshot.review;
  const expectedId = workspaceReviewIdentity(review.ownerUserId, contentRef, scopeRef);
  const check = (value: CollectiveWorkspaceSnapshot['review']) => {
    if (
      value.reviewId !== expectedId ||
      value.contentRef !== contentRef ||
      value.ownerUserId !== review.ownerUserId ||
      value.collaborationScope?.scopeRef !== scopeRef ||
      !isDeepStrictEqual(value.collaborationScope, review.collaborationScope) ||
      value.source.kind !== 'collective-artifact' ||
      value.revision > review.revision ||
      (value.visualMarks?.length ?? 0) > 0
    )
      throw new Error('Collective ledger scope mismatch');
    for (const annotation of value.annotations) {
      const message = annotation.collectiveMessage;
      if (
        !('kind' in annotation.anchor) ||
        annotation.anchor.kind !== 'text_quote' ||
        !message ||
        annotation.projectMessage ||
        annotation.projectHistory ||
        annotation.imageEdit ||
        message.serviceInstanceId !== value.collaborationScope.serviceInstanceId ||
        message.collectiveId !== value.collaborationScope.collectiveId ||
        message.blobDigest !== annotation.anchor.baseRevision
      )
        throw new Error('Collective annotation source mismatch');
    }
  };
  check(review);
  validateOperationReceipts(snapshot, expectedId, check);
  const revisions = new Set<number>();
  for (const retained of snapshot.retained) {
    check(retained);
    if (revisions.has(retained.revision)) throw new Error('Duplicate retained ledger revision');
    revisions.add(retained.revision);
  }
  return snapshot;
}

function validateOperationReceipts(
  snapshot: CollectiveWorkspaceSnapshot,
  expectedId: string,
  check: (review: WorkspaceContentReview) => void,
) {
  const review = snapshot.review;
  const keys = new Set<string>();
  const identities = new Map<string, string>();
  for (const item of snapshot.operations) {
    const key = `${item.generation}:${item.operationId}`;
    const expectedRef = `workspace-content-review:${expectedId}:receipt:${createHash('sha256').update(item.operationId).digest('hex')}`;
    const resultRevision =
      item.generation === 'result'
        ? item.review.revision
        : item.generation === 'receipt'
          ? item.resultRevision
          : item.revision;
    if (
      keys.has(key) ||
      item.receipt.reviewId !== expectedId ||
      item.receipt.operationId !== item.operationId ||
      item.receipt.receiptRef !== expectedRef ||
      item.receipt.revision !== resultRevision ||
      resultRevision > review.revision
    )
      throw new Error('Collective ledger receipt mismatch');
    keys.add(key);
    const identity = JSON.stringify([item.fingerprint, item.receipt]);
    const old = identities.get(item.operationId);
    if (old && old !== identity) throw new Error('Inconsistent Collective receipt generations');
    identities.set(item.operationId, identity);
    if (item.generation === 'result') check(item.review);
  }
}

export function rebindCollectiveWorkspaceSnapshot(
  snapshot: CollectiveWorkspaceSnapshot,
  ownerUserId: string,
): CollectiveWorkspaceSnapshot {
  return {
    ...snapshot,
    review: { ...snapshot.review, ownerUserId },
    operations: snapshot.operations.map((item) =>
      item.generation === 'result' ? { ...item, review: { ...item.review, ownerUserId } } : item,
    ),
    retained: snapshot.retained.map((review) => ({ ...review, ownerUserId })),
  };
}
