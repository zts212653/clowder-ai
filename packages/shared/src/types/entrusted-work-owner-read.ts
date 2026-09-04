import { z } from 'zod';
import {
  canonicalProducerEvidence,
  type EligibleAttentionReceipt,
  sameProducerEvidence,
  selectCanonicalOwnerTime,
  validateOwnerTimeCoordinates,
} from './entrusted-work-owner-read-evidence.js';
import { PHASE_B_NEEDS_ME_PRODUCER_IDS, producerAttentionReceiptV1Schema } from './growing.js';

const boundedRef = z.string().trim().min(1).max(1_000);
const boundedText = z.string().trim().min(1).max(4_000);
const revisionSchema = z.number().int().positive();
const timestampSchema = z.number().int().nonnegative().finite();

const ownerReadEnvelopeV1Schema = z
  .object({
    subjectRef: boundedRef,
    ownerRef: boundedRef,
    admissionReceiptRef: boundedRef,
    sourceRefs: z.array(boundedRef).min(1).max(64),
    revision: revisionSchema,
    freshness: z
      .object({
        state: z.enum(['current', 'stale']),
        observedRevision: revisionSchema,
      })
      .strict(),
    visibility: z
      .object({
        ownerUserId: boundedRef,
        human: z.boolean(),
        cat: z.boolean(),
      })
      .strict(),
  })
  .strict()
  .superRefine((envelope, context) => {
    const { state, observedRevision } = envelope.freshness;
    if (state === 'current' && observedRevision !== envelope.revision) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['freshness', 'observedRevision'],
        message: 'current read must observe the canonical owner revision',
      });
    }
    if (state === 'stale' && observedRevision >= envelope.revision) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['freshness', 'observedRevision'],
        message: 'stale read must identify an older observed revision',
      });
    }
  });

const preparedArtifactReadV1Schema = z
  .object({
    artifactRef: boundedRef,
    artifactRevision: boundedRef,
    completenessRef: boundedRef,
    previewRef: boundedRef,
    openInWorkspaceRef: boundedRef,
  })
  .strict();

const entrustedWorkTimeRefV1Schema = z
  .object({
    role: z.enum(['business_deadline', 'review_by', 'execution_trigger']),
    subjectRef: boundedRef,
    ownerRef: boundedRef,
    revision: revisionSchema,
    value: timestampSchema,
  })
  .strict();

const producerEvidenceV1Schema = z
  .object({
    producerId: z.enum(PHASE_B_NEEDS_ME_PRODUCER_IDS),
    ownerRef: boundedRef,
    revision: revisionSchema,
  })
  .strict();
const producerEvidenceListV1Schema = z.array(producerEvidenceV1Schema).min(1).max(PHASE_B_NEEDS_ME_PRODUCER_IDS.length);

/** Disposable, source-backed summary for a single admitted entrusted-work item. */
export const entrustedWorkBriefV1Schema = z
  .object({
    outcome: z.discriminatedUnion('state', [
      z
        .object({ state: z.literal('known'), value: boundedText, ownerRef: boundedRef, revision: revisionSchema })
        .strict(),
      z.object({ state: z.literal('unknown') }).strict(),
    ]),
    current: z
      .object({ state: z.enum(['todo', 'doing', 'blocked']), ownerRef: boundedRef, revision: revisionSchema })
      .strict(),
    verifiedMilestone: z.discriminatedUnion('kind', [
      z.object({ kind: z.literal('needs_judgment'), evidenceRef: boundedRef, revision: revisionSchema }).strict(),
      z
        .object({
          kind: z.literal('artifact_ready'),
          evidenceRef: boundedRef,
          revision: z.union([revisionSchema, boundedRef]),
        })
        .strict(),
      z
        .object({
          kind: z.literal('time_committed'),
          role: z.enum(['business_deadline', 'review_by', 'execution_trigger']),
          evidenceRef: boundedRef,
          revision: revisionSchema,
        })
        .strict(),
      z.object({ kind: z.literal('custody_admitted'), evidenceRef: boundedRef, revision: revisionSchema }).strict(),
      z
        .object({
          kind: z.literal('unknown'),
          reason: z.enum(['stale_owner_read', 'multiple_current_milestones']).optional(),
        })
        .strict(),
    ]),
    nextOwner: z.discriminatedUnion('kind', [
      z.object({ kind: z.literal('human'), ownerRef: boundedRef, evidence: producerEvidenceListV1Schema }).strict(),
      z
        .object({
          kind: z.literal('cat'),
          ownerRef: boundedRef,
          evidenceRef: boundedRef,
          revision: revisionSchema,
        })
        .strict(),
      z.object({ kind: z.literal('unknown') }).strict(),
    ]),
    needsMe: z.discriminatedUnion('state', [
      z.object({ state: z.literal('needed'), evidence: producerEvidenceListV1Schema }).strict(),
      z.object({ state: z.literal('not_needed'), evidenceRef: boundedRef, revision: revisionSchema }).strict(),
      z.object({ state: z.literal('unknown'), reason: z.literal('stale_owner_read') }).strict(),
    ]),
  })
  .strict();

/** One discardable read composition consumed without reinterpretation by Web and cat tools. */
export const entrustedWorkOwnerReadV1Schema = z
  .object({
    envelope: ownerReadEnvelopeV1Schema,
    brief: entrustedWorkBriefV1Schema,
    preparedArtifact: preparedArtifactReadV1Schema.optional(),
    timeRefs: z.array(entrustedWorkTimeRefV1Schema).max(64),
    attentionReceipts: z.array(producerAttentionReceiptV1Schema).max(PHASE_B_NEEDS_ME_PRODUCER_IDS.length),
  })
  .strict()
  .superRefine((ownerRead, context) => {
    validateBriefTaskCoordinates(ownerRead, context);
    if (ownerRead.envelope.freshness.state !== 'current' && ownerRead.attentionReceipts.length > 0) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['attentionReceipts'],
        message: 'stale owner reads cannot expose producer attention actions',
      });
    }
    ownerRead.attentionReceipts.forEach((receipt, index) => {
      if (receipt.taskRef.subjectRef !== ownerRead.envelope.subjectRef) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['attentionReceipts', index, 'taskRef', 'subjectRef'],
          message: 'attention receipt must reference the same Task subject',
        });
      }
      if (receipt.taskRef.observedRevision !== ownerRead.envelope.revision) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['attentionReceipts', index, 'taskRef', 'observedRevision'],
          message: 'attention receipt must observe the current Task revision',
        });
      }
    });
    validateOwnerTimeCoordinates(ownerRead, context);
    validateBriefAttentionAndMilestone(ownerRead, context);
  });

type OwnerReadRefinementInput = z.infer<typeof entrustedWorkOwnerReadV1Schema>;
function addBriefIssue(context: z.RefinementCtx, path: string, message: string): void {
  context.addIssue({ code: z.ZodIssueCode.custom, path: ['brief', path], message });
}

function validateBriefTaskCoordinates(ownerRead: OwnerReadRefinementInput, context: z.RefinementCtx): void {
  if (
    ownerRead.brief.current.ownerRef !== ownerRead.envelope.ownerRef ||
    ownerRead.brief.current.revision !== ownerRead.envelope.revision
  ) {
    addBriefIssue(context, 'current', 'brief current state must use the same Task owner coordinate');
  }
  if (
    ownerRead.brief.outcome.state === 'known' &&
    (ownerRead.brief.outcome.ownerRef !== ownerRead.envelope.ownerRef ||
      ownerRead.brief.outcome.revision !== ownerRead.envelope.revision)
  ) {
    addBriefIssue(context, 'outcome', 'brief outcome must use the same Task owner coordinate');
  }
  if (
    ownerRead.brief.nextOwner.kind === 'cat' &&
    (!ownerRead.brief.nextOwner.ownerRef.startsWith('cat:') ||
      ownerRead.brief.nextOwner.evidenceRef !== ownerRead.envelope.ownerRef ||
      ownerRead.brief.nextOwner.revision !== ownerRead.envelope.revision)
  ) {
    addBriefIssue(context, 'nextOwner', 'cat next owner must be backed by the current Task owner coordinate');
  }
}

function validateBriefAttentionAndMilestone(ownerRead: OwnerReadRefinementInput, context: z.RefinementCtx): void {
  const eligibleReceipts = ownerRead.attentionReceipts.filter(
    (receipt): receipt is EligibleAttentionReceipt => receipt.eligible,
  );
  if (ownerRead.envelope.freshness.state === 'stale') {
    if (
      ownerRead.brief.needsMe.state !== 'unknown' ||
      ownerRead.brief.nextOwner.kind !== 'unknown' ||
      ownerRead.brief.verifiedMilestone.kind !== 'unknown' ||
      ownerRead.brief.verifiedMilestone.reason !== 'stale_owner_read'
    ) {
      addBriefIssue(context, 'needsMe', 'stale owner reads must fail closed to unknown attention truth');
    }
    return;
  }
  validateBriefAttention(ownerRead, eligibleReceipts, context);
  validateBriefMilestone(ownerRead, eligibleReceipts, context);
}

function validateBriefAttention(
  ownerRead: OwnerReadRefinementInput,
  eligibleReceipts: EligibleAttentionReceipt[],
  context: z.RefinementCtx,
): void {
  const expectedHumanOwnerRef = `user:${ownerRead.envelope.visibility.ownerUserId}`;
  const evidence = canonicalProducerEvidence(eligibleReceipts);
  if (eligibleReceipts.length > 0) {
    if (
      ownerRead.brief.needsMe.state !== 'needed' ||
      !sameProducerEvidence(ownerRead.brief.needsMe.evidence, evidence) ||
      ownerRead.brief.nextOwner.kind !== 'human' ||
      ownerRead.brief.nextOwner.ownerRef !== expectedHumanOwnerRef ||
      !sameProducerEvidence(ownerRead.brief.nextOwner.evidence, evidence)
    ) {
      addBriefIssue(
        context,
        'needsMe',
        'needed brief state must match every current eligible producer coordinate and the human next owner',
      );
    }
    return;
  }
  if (
    ownerRead.brief.needsMe.state !== 'not_needed' ||
    ownerRead.brief.needsMe.evidenceRef !== ownerRead.envelope.ownerRef ||
    ownerRead.brief.needsMe.revision !== ownerRead.envelope.revision ||
    ownerRead.brief.nextOwner.kind === 'human'
  ) {
    addBriefIssue(
      context,
      'needsMe',
      'not-needed brief state must use the current Task coordinate and cannot retain a human next owner',
    );
  }
}

function validateBriefMilestone(
  ownerRead: OwnerReadRefinementInput,
  eligibleReceipts: EligibleAttentionReceipt[],
  context: z.RefinementCtx,
): void {
  if (eligibleReceipts.length > 0) {
    validateAttentionMilestone(ownerRead, eligibleReceipts, context);
    return;
  }
  validateOwnerMilestone(ownerRead, context);
}

function validateAttentionMilestone(
  ownerRead: OwnerReadRefinementInput,
  eligibleReceipts: EligibleAttentionReceipt[],
  context: z.RefinementCtx,
): void {
  const milestone = ownerRead.brief.verifiedMilestone;
  if (eligibleReceipts.length === 1) {
    const [eligibleReceipt] = eligibleReceipts;
    if (
      !eligibleReceipt ||
      milestone.kind !== 'needs_judgment' ||
      milestone.evidenceRef !== eligibleReceipt.producer.ownerRef ||
      milestone.revision !== eligibleReceipt.producer.revision
    ) {
      addBriefIssue(context, 'verifiedMilestone', 'judgment milestone must match the sole eligible producer receipt');
    }
    return;
  }
  if (milestone.kind !== 'unknown' || milestone.reason !== 'multiple_current_milestones') {
    addBriefIssue(context, 'verifiedMilestone', 'multiple producer milestones must remain explicitly ambiguous');
  }
}

function validateOwnerMilestone(ownerRead: OwnerReadRefinementInput, context: z.RefinementCtx): void {
  const milestone = ownerRead.brief.verifiedMilestone;
  if (ownerRead.preparedArtifact) {
    if (
      milestone.kind !== 'artifact_ready' ||
      milestone.evidenceRef !== ownerRead.preparedArtifact.completenessRef ||
      milestone.revision !== ownerRead.preparedArtifact.artifactRevision
    ) {
      addBriefIssue(
        context,
        'verifiedMilestone',
        'Artifact milestone must match the prepared Artifact owner coordinate',
      );
    }
    return;
  }
  const primaryTime = selectCanonicalOwnerTime(ownerRead.timeRefs);
  if (primaryTime) {
    if (
      milestone.kind !== 'time_committed' ||
      milestone.role !== primaryTime.role ||
      milestone.evidenceRef !== primaryTime.ownerRef ||
      milestone.revision !== primaryTime.revision
    ) {
      addBriefIssue(context, 'verifiedMilestone', 'time milestone must match the canonical typed Task time coordinate');
    }
    return;
  }
  if (
    milestone.kind !== 'custody_admitted' ||
    milestone.evidenceRef !== ownerRead.envelope.admissionReceiptRef ||
    milestone.revision !== ownerRead.envelope.revision
  ) {
    addBriefIssue(context, 'verifiedMilestone', 'custody milestone must match the canonical Task admission receipt');
  }
}

export type EntrustedWorkBriefV1 = z.infer<typeof entrustedWorkBriefV1Schema>;
export type EntrustedWorkOwnerReadV1 = z.infer<typeof entrustedWorkOwnerReadV1Schema>;
