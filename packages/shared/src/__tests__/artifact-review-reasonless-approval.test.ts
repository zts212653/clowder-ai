import { expect, it } from 'vitest';
import { artifactReviewActionSchema, artifactReviewRoundSchema } from '../types/artifact-review.js';

it('accepts an explicit approval with no prose while changes and reopening still require human words', () => {
  expect(artifactReviewActionSchema.safeParse({ kind: 'decide', outcome: 'approved', explanation: '' }).success).toBe(
    true,
  );
  expect(
    artifactReviewActionSchema.safeParse({ kind: 'decide', outcome: 'changes_requested', explanation: '' }).success,
  ).toBe(false);
  expect(artifactReviewActionSchema.safeParse({ kind: 'reopen', explanation: '' }).success).toBe(false);
});
it('round decision storage retains an empty genuine approval without allowing empty change requests', () => {
  const decision = artifactReviewRoundSchema.shape.decision.unwrap();
  const value = {
    outcome: 'approved',
    explanation: '',
    actor: { kind: 'human', actorId: 'operator' },
    decidedAt: '2026-10-13T23:00:00Z',
    receiptRef: 'review-receipt:approval',
  };
  expect(decision.safeParse(value).success).toBe(true);
  expect(decision.safeParse({ ...value, outcome: 'changes_requested' }).success).toBe(false);
});
