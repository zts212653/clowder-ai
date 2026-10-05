import { z } from 'zod';
import { validateOwnerTimeCoordinates } from './entrusted-work-owner-read-evidence.js';
import {
  validateBriefAttentionAndMilestone,
  validateBriefTaskCoordinates,
} from './entrusted-work-owner-read-validation.js';
import { entrustedWorkV1Schema, NEEDS_ME_PRODUCER_IDS, producerAttentionReceiptV1Schema } from './growing.js';
import { preparedArtifactSnapshotV1Schema } from './growing-artifact.js';

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

const preparedArtifactReadV1Schema = preparedArtifactSnapshotV1Schema;

const entrustedWorkTimeRefV1Schema = z
  .object({
    role: z.enum([
      'business_deadline',
      'review_by',
      'execution_trigger',
      'planned_start',
      'actual_start',
      'estimated_completion',
    ]),
    subjectRef: boundedRef,
    ownerRef: boundedRef,
    revision: revisionSchema,
    value: timestampSchema,
  })
  .strict();

const producerEvidenceV1Schema = z
  .object({
    producerId: z.enum(NEEDS_ME_PRODUCER_IDS),
    ownerRef: boundedRef,
    revision: revisionSchema,
  })
  .strict();
const producerEvidenceListV1Schema = z.array(producerEvidenceV1Schema).min(1).max(NEEDS_ME_PRODUCER_IDS.length);

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
      .object({ state: z.enum(['todo', 'doing', 'blocked', 'done']), ownerRef: boundedRef, revision: revisionSchema })
      .strict(),
    verifiedMilestone: z.discriminatedUnion('kind', [
      z.object({ kind: z.literal('work_completed'), evidenceRef: boundedRef, revision: revisionSchema }).strict(),
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
          role: z.enum([
            'business_deadline',
            'review_by',
            'execution_trigger',
            'planned_start',
            'actual_start',
            'estimated_completion',
          ]),
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
    // Read-only presentation from the same authorized Task snapshot; admission is not a start or due date.
    work: z
      .object({
        title: boundedText,
        ownerCatId: boundedRef.nullable(),
        threadId: boundedRef,
        admittedAt: timestampSchema,
        ownerNote: z.string().max(4_000),
        progress: entrustedWorkV1Schema.shape.progress,
      })
      .strict()
      .optional(),
    preparedArtifact: preparedArtifactReadV1Schema.optional(),
    completion: z
      .object({ recordedAt: timestampSchema.optional(), evidenceRefs: z.array(boundedRef).min(1).max(64) })
      .strict()
      .optional(),
    timeRefs: z.array(entrustedWorkTimeRefV1Schema).max(64),
    attentionReceipts: z.array(producerAttentionReceiptV1Schema).max(NEEDS_ME_PRODUCER_IDS.length),
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

export type EntrustedWorkBriefV1 = z.infer<typeof entrustedWorkBriefV1Schema>;
export type EntrustedWorkOwnerReadV1 = z.infer<typeof entrustedWorkOwnerReadV1Schema>;
