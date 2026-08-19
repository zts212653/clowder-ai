import { describe, expect, it } from 'vitest';
import {
  actionSuccessorMetadataSchema,
  dispatchProposedActionInputSchema,
  isAllowedActionSuccessorSlot,
} from '../types/action-successor.js';
import { executableActionSuccessorMetadataSchema } from '../types/executable-action-successor.js';

const FULL_HEAD_SHA = 'a'.repeat(40);

describe('action successor shared contract', () => {
  it('accepts the canonical PR merge reviewer slot', () => {
    const parsed = actionSuccessorMetadataSchema.parse({
      subjectRef: 'pr:owner/repo#2868',
      actionFamily: 'merge',
      successorSlot: 'reviewer',
      mode: 'single',
      terminalPredicate: { kind: 'pr_merged' },
    });
    expect(parsed.actionFamily).toBe('merge');
    expect(isAllowedActionSuccessorSlot('merge', 'reviewer')).toBe(true);
  });

  it('keeps reserved vocabulary out of executable direct carriers', () => {
    expect(
      executableActionSuccessorMetadataSchema.safeParse({
        subjectRef: 'pr:owner/repo#2868',
        actionFamily: 'merge',
        successorSlot: 'merge_owner',
        mode: 'single',
        terminalPredicate: { kind: 'pr_merged' },
      }).success,
    ).toBe(false);
    expect(
      executableActionSuccessorMetadataSchema.safeParse({
        subjectRef: 'pr:owner/repo#2868',
        actionFamily: 'review',
        successorSlot: 'reviewer',
        mode: 'single',
        terminalPredicate: { kind: 'review_delivered', headSha: FULL_HEAD_SHA },
      }).success,
    ).toBe(true);
    expect(
      executableActionSuccessorMetadataSchema.safeParse({
        subjectRef: 'subject:task:task-1',
        actionFamily: 'implement',
        successorSlot: 'implementer',
        mode: 'single',
        terminalPredicate: { kind: 'task_done' },
      }).success,
    ).toBe(true);
    expect(
      executableActionSuccessorMetadataSchema.safeParse({
        subjectRef: 'pr:owner/repo#2868',
        actionFamily: 'review',
        successorSlot: 'reviewer',
        mode: 'single',
        terminalPredicate: { kind: 'task_done' },
      }).success,
    ).toBe(false);
  });

  it('uses canonical subject grammar for every successor carrier', () => {
    const invalid = actionSuccessorMetadataSchema.safeParse({
      subjectRef: 'github:owner/repo#2868@abc1234',
      actionFamily: 'review',
      successorSlot: 'reviewer',
      mode: 'single',
      terminalPredicate: { kind: 'review_delivered', headSha: FULL_HEAD_SHA },
    });
    expect(invalid.success).toBe(false);
    expect(
      actionSuccessorMetadataSchema.safeParse({
        subjectRef: 'pr:owner/repo#2868',
        actionFamily: 'review',
        successorSlot: 'reviewer',
        mode: 'single',
        terminalPredicate: { kind: 'review_delivered', headSha: FULL_HEAD_SHA },
      }).success,
    ).toBe(true);
  });

  it('rejects arbitrary slots that could evade the canonical key', () => {
    expect(
      actionSuccessorMetadataSchema.safeParse({
        subjectRef: 'pr:owner/repo#2868',
        actionFamily: 'merge',
        successorSlot: 'reviewer-2',
        mode: 'single',
      }).success,
    ).toBe(false);
  });

  it('requires explicit intent for parallel cardinality', () => {
    expect(
      actionSuccessorMetadataSchema.safeParse({
        subjectRef: 'pr:owner/repo#2868',
        actionFamily: 'review',
        successorSlot: 'reviewer',
        mode: 'parallel',
      }).success,
    ).toBe(false);
    expect(
      actionSuccessorMetadataSchema.safeParse({
        subjectRef: 'pr:owner/repo#2868',
        actionFamily: 'review',
        successorSlot: 'reviewer',
        mode: 'parallel',
        parallelIntent: 'independent_review',
        terminalPredicate: { kind: 'review_delivered', headSha: FULL_HEAD_SHA },
      }).success,
    ).toBe(true);
  });

  it('rejects abbreviated or non-canonical HEADs before creating a lease', () => {
    const base = {
      subjectRef: 'pr:owner/repo#2868',
      actionFamily: 'review',
      successorSlot: 'reviewer',
      mode: 'single',
    } as const;

    for (const headSha of ['abc1234', 'A'.repeat(40), 'g'.repeat(40), 'a'.repeat(39), 'a'.repeat(41)]) {
      expect(
        actionSuccessorMetadataSchema.safeParse({
          ...base,
          terminalPredicate: { kind: 'review_delivered', headSha },
        }).success,
      ).toBe(false);
    }
    expect(
      actionSuccessorMetadataSchema.safeParse({
        ...base,
        terminalPredicate: { kind: 'review_delivered', headSha: 'b'.repeat(64) },
      }).success,
    ).toBe(true);
  });

  it('admits only typed local-review re-entry reasons with durable evidence', () => {
    const base = {
      subjectRef: 'pr:owner/repo#2868',
      actionFamily: 'review',
      successorSlot: 'reviewer',
      mode: 'single',
      terminalPredicate: { kind: 'review_delivered', headSha: FULL_HEAD_SHA },
    } as const;

    for (const reason of ['behavioral_delta', 'stale_or_blocking', 'explicit_matrix_route'] as const) {
      const parsed = actionSuccessorMetadataSchema.parse({
        ...base,
        reviewReentry: { reason, evidenceRef: `message:review-route:${reason}` },
      });
      expect(parsed.reviewReentry).toEqual({ reason, evidenceRef: `message:review-route:${reason}` });
    }

    expect(
      actionSuccessorMetadataSchema.safeParse({
        ...base,
        reviewReentry: { reason: 'cloud_finding', evidenceRef: 'message:wrong-gate-owner' },
      }).success,
    ).toBe(false);
    expect(
      actionSuccessorMetadataSchema.safeParse({
        ...base,
        reviewReentry: { reason: 'behavioral_delta', evidenceRef: '   ' },
      }).success,
    ).toBe(false);
    expect(
      actionSuccessorMetadataSchema.safeParse({
        ...base,
        actionFamily: 'merge',
        reviewReentry: { reason: 'explicit_matrix_route', evidenceRef: 'message:not-a-review-action' },
      }).success,
    ).toBe(false);
  });

  it('requires durable grounding evidence for an existing-standing self claim', () => {
    const missingEvidence = actionSuccessorMetadataSchema.safeParse({
      subjectRef: 'pr:owner/repo#2868',
      actionFamily: 'implement',
      successorSlot: 'implementer',
      mode: 'single',
      claimOrigin: 'existing_standing',
    });
    expect(missingEvidence.success).toBe(false);

    const grounded = actionSuccessorMetadataSchema.parse({
      subjectRef: 'pr:owner/repo#2868',
      actionFamily: 'implement',
      successorSlot: 'implementer',
      mode: 'single',
      claimOrigin: 'existing_standing',
      groundingEvidenceRef: 'message:0001784216152511',
      terminalPredicate: {
        kind: 'durable_verdict',
        verdictRef: 'verdict:implementation-complete',
        freshnessKey: 'sha:abc1234',
      },
    });
    expect(grounded.claimOrigin).toBe('existing_standing');
  });

  it('models a task-backed implement standing with task completion as the terminal truth', () => {
    const parsed = actionSuccessorMetadataSchema.parse({
      subjectRef: 'subject:task:0001785487739814-000166-1b36feaf',
      actionFamily: 'implement',
      successorSlot: 'implementer',
      mode: 'single',
      claimOrigin: 'existing_standing',
      groundingEvidenceRef: 'message:0001785490292842-000230-72665e74',
      terminalPredicate: { kind: 'task_done' },
    });

    expect(parsed.terminalPredicate).toEqual({ kind: 'task_done' });
  });

  it('exposes only executable initial approval pairs', () => {
    const review = dispatchProposedActionInputSchema.safeParse({
      subjectRef: 'pr:owner/repo#2868',
      actionFamily: 'review',
      successorSlot: 'reviewer',
      mode: 'single',
      terminalPredicate: { kind: 'review_delivered', headSha: FULL_HEAD_SHA },
    });
    const implementation = dispatchProposedActionInputSchema.safeParse({
      subjectRef: 'subject:task:0001785487739814-000166-1b36feaf',
      actionFamily: 'implement',
      successorSlot: 'implementer',
      mode: 'single',
      terminalPredicate: { kind: 'task_done' },
    });
    expect(review.success).toBe(true);
    expect(implementation.success).toBe(true);

    for (const unsupported of [
      {
        subjectRef: 'pr:owner/repo#2868',
        actionFamily: 'implement',
        successorSlot: 'implementer',
        mode: 'single',
        terminalPredicate: { kind: 'review_delivered', headSha: FULL_HEAD_SHA },
      },
      {
        subjectRef: 'subject:other:opaque-id',
        actionFamily: 'implement',
        successorSlot: 'implementer',
        mode: 'single',
        terminalPredicate: { kind: 'task_done' },
      },
      {
        subjectRef: 'subject:task:\u001f',
        actionFamily: 'implement',
        successorSlot: 'implementer',
        mode: 'single',
        terminalPredicate: { kind: 'task_done' },
      },
      {
        subjectRef: 'subject:task:task-1',
        actionFamily: 'implement',
        successorSlot: 'implementer',
        mode: 'single',
        claimOrigin: 'existing_standing',
        groundingEvidenceRef: 'message:not-an-initial-transfer',
        terminalPredicate: { kind: 'task_done' },
      },
    ]) {
      expect(dispatchProposedActionInputSchema.safeParse(unsupported).success).toBe(false);
    }
  });

  it('models rejected custody as single return or parallel holder-only termination, never replace', () => {
    const parsed = actionSuccessorMetadataSchema.parse({
      subjectRef: 'pr:owner/repo#2868',
      actionFamily: 'implement',
      successorSlot: 'implementer',
      mode: 'single',
      returnToPredecessor: {
        leaseId: 'lease-1',
        expectedGeneration: 1,
        groundingEvidenceRef: 'message:grounding-mismatch',
      },
    });
    expect(parsed.returnToPredecessor?.leaseId).toBe('lease-1');

    expect(
      actionSuccessorMetadataSchema.safeParse({
        ...parsed,
        replace: { leaseId: 'lease-1', expectedGeneration: 1 },
      }).success,
    ).toBe(false);
    expect(
      actionSuccessorMetadataSchema.safeParse({
        ...parsed,
        mode: 'parallel',
        parallelIntent: 'independent implementation',
      }).success,
    ).toBe(true);
  });

  it('allows a grounded existing-standing replacement without weakening its self-standing contract', () => {
    const replacement = {
      subjectRef: 'subject:task:task-1',
      actionFamily: 'implement',
      successorSlot: 'implementer',
      mode: 'single',
      claimOrigin: 'existing_standing',
      groundingEvidenceRef: 'grounding:verified-owner',
      terminalPredicate: { kind: 'task_done' },
      replace: { leaseId: 'lease-1', expectedGeneration: 1 },
    } as const;

    expect(actionSuccessorMetadataSchema.safeParse(replacement).success).toBe(true);
    expect(
      actionSuccessorMetadataSchema.safeParse({
        ...replacement,
        groundingEvidenceRef: undefined,
      }).success,
    ).toBe(false);
  });

  it('requires a typed terminal predicate for replacement generations while allowing a pure return', () => {
    const replacement = {
      subjectRef: 'pr:owner/repo#2868',
      actionFamily: 'review',
      successorSlot: 'reviewer',
      mode: 'single',
      replace: { leaseId: 'lease-1', expectedGeneration: 1 },
    } as const;
    expect(actionSuccessorMetadataSchema.safeParse(replacement).success).toBe(false);
    expect(
      actionSuccessorMetadataSchema.safeParse({
        ...replacement,
        terminalPredicate: { kind: 'review_delivered', headSha: FULL_HEAD_SHA },
      }).success,
    ).toBe(true);
  });
});
