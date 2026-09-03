import { z } from 'zod';

const boundedRef = z.string().trim().min(1).max(1_000);
const boundedText = z.string().trim().min(1).max(4_000);
const revisionSchema = z.number().int().positive();
const timestampSchema = z.number().int().nonnegative().finite();
const sourceRefsSchema = z.array(boundedRef).min(1).max(64);

/** Immutable Message-owner content revision. Mutable counters and extra blobs are not valid source truth. */
export const growingSourceMessageRevisionV1Schema = z.string().regex(/^sha256:[a-f0-9]{64}$/);

const admittedOrResumedSchema = z
  .object({
    result: z.enum(['admitted', 'resumed']),
    subjectRef: boundedRef,
    ownerRef: boundedRef,
    revision: revisionSchema,
    receiptRef: boundedRef,
  })
  .strict();

const needsClarificationSchema = z
  .object({
    result: z.literal('needs_clarification'),
    clarificationReason: boundedText,
  })
  .strict();

export const custodyAdmissionResultV1Schema = z.discriminatedUnion('result', [
  admittedOrResumedSchema,
  needsClarificationSchema,
]);

export const custodyAdmissionStateV1Schema = z.discriminatedUnion('state', [
  z
    .object({
      state: z.literal('pending'),
      idempotencyKey: boundedRef,
    })
    .strict(),
  z
    .object({
      state: z.literal('resulted'),
      idempotencyKey: boundedRef,
      result: custodyAdmissionResultV1Schema,
    })
    .strict(),
]);

const custodyOfferBase = {
  offerId: boundedRef,
  sourceMessageRevision: growingSourceMessageRevisionV1Schema,
  policyVersion: boundedRef,
  reasonCode: boundedRef,
};

const refusedOffer = (disposition: 'declined' | 'dismissed') =>
  z
    .object({
      ...custodyOfferBase,
      disposition: z.literal(disposition),
      actorRef: boundedRef,
      dispositionAt: timestampSchema,
    })
    .strict();

/** Source-owned offer/disposition carrier. Only the exact Message record may persist this shape. */
export const custodyOfferV1Schema = z.discriminatedUnion('disposition', [
  z.object({ ...custodyOfferBase, disposition: z.literal('pending') }).strict(),
  z
    .object({
      ...custodyOfferBase,
      disposition: z.literal('accepted'),
      actorRef: boundedRef,
      dispositionAt: timestampSchema,
      admission: custodyAdmissionStateV1Schema,
    })
    .strict(),
  refusedOffer('declined'),
  refusedOffer('dismissed'),
]);

const entrustedAdmissionBase = {
  sourceRefs: sourceRefsSchema,
  idempotencyKey: boundedRef,
  receiptRef: boundedRef,
  admittedAt: timestampSchema,
};

const entrustedAdmissionSchema = z.discriminatedUnion('basis', [
  z.object({ ...entrustedAdmissionBase, basis: z.literal('explicit_entrustment') }).strict(),
  z.object({ ...entrustedAdmissionBase, basis: z.literal('accepted_offer') }).strict(),
  z
    .object({
      ...entrustedAdmissionBase,
      basis: z.literal('authorized_source'),
      authorityRef: boundedRef,
    })
    .strict(),
]);

const businessTimeFactSchema = z
  .object({
    value: timestampSchema,
    sourceRef: boundedRef,
  })
  .strict();

const closureBase = {
  condition: boundedText,
  expectedSignal: boundedRef,
};

const terminalClosureDisposition = (kind: 'cancelled' | 'abandoned') =>
  z
    .object({
      kind: z.literal(kind),
      actorKind: z.enum(['human', 'owner']),
      actorRef: boundedRef,
      authorityRef: boundedRef,
      dispositionRef: boundedRef,
      disposedAt: timestampSchema,
    })
    .strict();

const entrustedClosureSchema = z.discriminatedUnion('state', [
  z
    .object({
      ...closureBase,
      state: z.literal('open'),
      evidenceRefs: z.array(boundedRef).max(64),
    })
    .strict(),
  z
    .object({
      ...closureBase,
      state: z.literal('satisfied'),
      evidenceRefs: z.array(boundedRef).min(1).max(64),
    })
    .strict(),
  z
    .object({
      ...closureBase,
      state: z.literal('cancelled'),
      evidenceRefs: z.array(boundedRef).max(64),
      disposition: terminalClosureDisposition('cancelled'),
    })
    .strict(),
  z
    .object({
      ...closureBase,
      state: z.literal('abandoned'),
      evidenceRefs: z.array(boundedRef).max(64),
      disposition: terminalClosureDisposition('abandoned'),
    })
    .strict(),
]);

/** Task-owned durable responsibility contract. It intentionally has no attention judgment fields. */
export const entrustedWorkV1Schema = z
  .object({
    revision: revisionSchema,
    admission: entrustedAdmissionSchema,
    intendedOutcome: boundedText,
    time: z
      .object({
        businessDeadline: businessTimeFactSchema.optional(),
        reviewBy: businessTimeFactSchema.optional(),
      })
      .strict(),
    artifactRefs: z.array(boundedRef).max(64),
    closure: entrustedClosureSchema,
  })
  .strict();

export const PHASE_B_NEEDS_ME_PRODUCER_IDS = ['f246.approval', 'f292.repair', 'f306.runtime_interaction'] as const;

const producerCoordinateSchema = z
  .object({
    producerId: z.enum(PHASE_B_NEEDS_ME_PRODUCER_IDS),
    ownerRef: boundedRef,
    subjectRef: boundedRef,
    revision: revisionSchema,
  })
  .strict();

export const entrustedWorkTaskRefV1Schema = z
  .object({
    subjectRef: boundedRef,
    observedRevision: revisionSchema,
  })
  .strict();

/** F139-owned execution link. It carries owner coordinates only; business time stays on Task. */
export const producerAttentionReevaluationLinkV1Schema = z
  .object({
    version: z.literal(1),
    ownerUserId: boundedRef,
    taskRef: entrustedWorkTaskRefV1Schema,
    producer: z
      .object({
        producerId: z.enum(PHASE_B_NEEDS_ME_PRODUCER_IDS),
        subjectRef: boundedRef,
        observedRevision: revisionSchema,
      })
      .strict(),
    reEvaluateActionRef: boundedRef,
  })
  .strict()
  .superRefine((link, context) => {
    if (link.reEvaluateActionRef !== `${link.producer.subjectRef}#reevaluate`) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['reEvaluateActionRef'],
        message: 'reEvaluateActionRef must be the canonical producer action',
      });
    }
  });

const ineligibleAttentionReceiptSchema = z
  .object({
    eligible: z.literal(false),
    producer: producerCoordinateSchema,
    taskRef: entrustedWorkTaskRefV1Schema,
    reEvaluateActionRef: boundedRef,
  })
  .strict();

const eligibleAttentionReceiptSchema = z
  .object({
    eligible: z.literal(true),
    producer: producerCoordinateSchema,
    taskRef: entrustedWorkTaskRefV1Schema,
    kind: z.enum(['judgment', 'repair']),
    reasonCode: boundedRef,
    recommendation: boundedText,
    salience: z.enum(['normal', 'near_deadline', 'high_risk']),
    action: z
      .object({
        actionRef: boundedRef,
        expectedProducerRevision: revisionSchema,
      })
      .strict(),
    reEvaluateActionRef: boundedRef,
  })
  .strict();

/** Producer-owned eligibility/action receipt. F310 may read it but never mutate its owner. */
export const producerAttentionReceiptV1Schema = z
  .discriminatedUnion('eligible', [ineligibleAttentionReceiptSchema, eligibleAttentionReceiptSchema])
  .superRefine((receipt, context) => {
    if (receipt.eligible && receipt.action.expectedProducerRevision !== receipt.producer.revision) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['action', 'expectedProducerRevision'],
        message: 'action revision must match current producer revision',
      });
    }
  });

const ownerReadEnvelopeV1Schema = z
  .object({
    subjectRef: boundedRef,
    ownerRef: boundedRef,
    sourceRefs: sourceRefsSchema,
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

/** One discardable read composition consumed without reinterpretation by Web and cat tools. */
export const entrustedWorkOwnerReadV1Schema = z
  .object({
    envelope: ownerReadEnvelopeV1Schema,
    preparedArtifact: preparedArtifactReadV1Schema.optional(),
    timeRefs: z.array(entrustedWorkTimeRefV1Schema).max(64),
    attentionReceipts: z.array(producerAttentionReceiptV1Schema).max(PHASE_B_NEEDS_ME_PRODUCER_IDS.length),
  })
  .strict()
  .superRefine((ownerRead, context) => {
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
  });

export type CustodyAdmissionResultV1 = z.infer<typeof custodyAdmissionResultV1Schema>;
export type CustodyAdmissionStateV1 = z.infer<typeof custodyAdmissionStateV1Schema>;
export type CustodyOfferV1 = z.infer<typeof custodyOfferV1Schema>;
export type EntrustedWorkV1 = z.infer<typeof entrustedWorkV1Schema>;
export type EntrustedWorkTaskRefV1 = z.infer<typeof entrustedWorkTaskRefV1Schema>;
export type PhaseBNeedsMeProducerId = (typeof PHASE_B_NEEDS_ME_PRODUCER_IDS)[number];
export type ProducerAttentionReevaluationLinkV1 = z.infer<typeof producerAttentionReevaluationLinkV1Schema>;
export type ProducerAttentionReceiptV1 = z.infer<typeof producerAttentionReceiptV1Schema>;
export type EntrustedWorkOwnerReadV1 = z.infer<typeof entrustedWorkOwnerReadV1Schema>;
