import type { ContentModificationRecord } from '@cat-cafe/shared';
import { describe, expect, it } from 'vitest';
import { modificationReviewBinding } from '../modification-review-binding';

// Which review a modification request belongs to is read from what the owner committed, never from which asset happens
// to match: the same version can be a round of a sibling review.
const A = `review-${'a'.repeat(64)}`;
const B = `review-${'b'.repeat(64)}`;
const record = (parts: {
  progressReview?: string;
  taskContext?: Record<string, unknown>;
  source?: Record<string, unknown>;
}): ContentModificationRecord =>
  ({
    requestId: 'r',
    ownerUserId: 'operator',
    revision: 1,
    createdAt: 1,
    updatedAt: 1,
    progress: parts.progressReview ? { review: { reviewId: parts.progressReview, round: 1, receiptRef: 'bound' } } : {},
    payload: {
      source: parts.source ?? {
        kind: 'publication',
        contentRef: 'c',
        ownerRevision: 1,
        ledgerRef: 'l',
        expectedLedgerRevision: 1,
      },
      ...(parts.taskContext ? { taskContext: parts.taskContext } : {}),
    },
  }) as unknown as ContentModificationRecord;
const media = (reviewId: string) => ({
  kind: 'media',
  taskId: 't',
  expectedTaskRevision: 1,
  reviewId,
  expectedReviewRevision: 1,
  round: 1,
});

describe('modificationReviewBinding', () => {
  it('reads the committed binding when that is all there is (a task and review created at bind time)', () => {
    expect(modificationReviewBinding(record({ progressReview: A }))).toEqual({ state: 'bound', reviewId: A });
  });

  it('reads the request-time context when nothing is committed yet', () => {
    expect(modificationReviewBinding(record({ taskContext: media(A) }))).toEqual({ state: 'bound', reviewId: A });
  });

  it('reads the review of a Task-round source when it is the only evidence', () => {
    const source = { kind: 'artifact-review', reviewId: A, round: 1, expectedReviewRevision: 1 };
    expect(modificationReviewBinding(record({ source }))).toEqual({ state: 'bound', reviewId: A });
  });

  it('accepts a context whose kind is not stated: it is still a media context with a review', () => {
    const bare = { taskId: 't', expectedTaskRevision: 1, reviewId: A, expectedReviewRevision: 1, round: 1 };
    expect(modificationReviewBinding(record({ taskContext: bare }))).toEqual({ state: 'bound', reviewId: A });
  });

  it('is bound when every piece of evidence names the same review', () => {
    const source = { kind: 'artifact-review', reviewId: A, round: 1, expectedReviewRevision: 1 };
    expect(modificationReviewBinding(record({ progressReview: A, taskContext: media(A), source }))).toEqual({
      state: 'bound',
      reviewId: A,
    });
  });

  it('is in conflict, not bound to either, when the evidence names different reviews', () => {
    expect(modificationReviewBinding(record({ progressReview: A, taskContext: media(B) }))).toEqual({
      state: 'conflict',
    });
    const source = { kind: 'artifact-review', reviewId: B, round: 1, expectedReviewRevision: 1 };
    expect(modificationReviewBinding(record({ progressReview: A, source }))).toEqual({ state: 'conflict' });
    expect(modificationReviewBinding(record({ taskContext: media(A), source }))).toEqual({ state: 'conflict' });
  });

  it('is unbound, not guessed, when nothing names a review', () => {
    expect(modificationReviewBinding(record({}))).toEqual({ state: 'unbound' });
  });

  it("does not read a text context or another kind of source's review id as an artifact review", () => {
    const text = { kind: 'text', taskId: 't', expectedTaskRevision: 1 };
    expect(modificationReviewBinding(record({ taskContext: text }))).toEqual({ state: 'unbound' });
    // A workspace file's review and an experiment's review are different families of review.
    const workspace = {
      kind: 'workspace',
      locator: { worktreeId: 'w', path: 'p' },
      reviewId: A,
      expectedReviewRevision: 1,
    };
    expect(modificationReviewBinding(record({ source: workspace }))).toEqual({ state: 'unbound' });
    const evolution = { kind: 'evolution', reviewId: A, expectedReviewRevision: 1 };
    expect(modificationReviewBinding(record({ source: evolution }))).toEqual({ state: 'unbound' });
  });
});
