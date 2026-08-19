import { z } from 'zod';
import {
  boundedString,
  captureCandidateIdSchema,
  ownerUserIdSchema,
  personMemorySourceRefSchema,
  requesterCatIdSchema,
  timestampSchema,
} from './person-memory-base.js';

const digestSchema = z.string().regex(/^[a-f0-9]{64}$/);
const attachmentLocatorSchema = z
  .object({
    surface: z.enum(['content_block', 'rich_block']).describe('Attachment surface on the exact owner message.'),
    index: z.number().int().nonnegative().max(100).describe('Zero-based attachment block index, from 0 through 100.'),
  })
  .strict();

export const deferredPersonMemoryReceiptIdSchema = z.string().regex(/^deferred_person_[a-f0-9]{32}$/);

/**
 * Wave 2 bridge: content-free identity of the Standing Reflex write opportunity whose bounded
 * judgment produced this receipt. IDs only — it carries no subject, excerpt, or transcript, so it
 * survives the terminal payload purge alongside `proposalId` and proves that a deferred opportunity
 * re-entered and landed on the same F276 destination proposal (SR:126-127, SR:174-176).
 */
export const writeOpportunityLineageV1Schema = z
  .object({
    reflexId: z.literal('asr-person-memory'),
    reflexVersion: z.literal(1),
    opportunityId: z.string().regex(/^write_opp_[a-f0-9]{32}$/),
    dedupeLineage: z.string().regex(/^write_lineage_[a-f0-9]{32}$/),
    generation: z.number().int().positive().max(0xffff_ffff),
  })
  .strict();

export type WriteOpportunityLineageV1 = z.infer<typeof writeOpportunityLineageV1Schema>;

/**
 * What a cat may claim about which opportunity it is dispositioning. Deliberately the minimum
 * identity triple: the server validates it against its own delivered-record evidence and never
 * trusts any of it. Inferring the target instead would be ambiguous the moment two opportunities
 * were delivered in one invocation (KD-8).
 */
export const writeOpportunityRefV1Schema = z
  .object({
    opportunityId: z.string().regex(/^write_opp_[a-f0-9]{32}$/),
    dedupeLineage: z.string().regex(/^write_lineage_[a-f0-9]{32}$/),
    generation: z.number().int().positive().max(0xffff_ffff),
  })
  .strict();

export type WriteOpportunityRefV1 = z.infer<typeof writeOpportunityRefV1Schema>;

export const deferredWriteOpportunitySourceRefV1Schema = z
  .object({
    artifactId: boundedString(240),
    sourceRevision: z.string().regex(/^sha256:[a-f0-9]{64}$/),
    attributionRevision: z.string().regex(/^sha256:[a-f0-9]{64}$/),
    segmentStart: z.number().int().nonnegative(),
    segmentEnd: z.number().int().positive(),
  })
  .strict()
  .refine((value) => value.segmentEnd > value.segmentStart, {
    path: ['segmentEnd'],
    message: 'segment end must be greater than start',
  });

export const deferredWriteOpportunityReceiptV1Schema = z
  .object({
    v: z.literal(1),
    receiptId: deferredPersonMemoryReceiptIdSchema,
    opportunityId: z.string().regex(/^write_opp_[a-f0-9]{32}$/),
    reflexId: z.literal('asr-person-memory'),
    reflexVersion: z.literal(1),
    generation: z.number().int().positive().max(0xffff_ffff),
    dedupeLineage: z.string().regex(/^write_lineage_[a-f0-9]{32}$/),
    sourceRefs: z.array(deferredWriteOpportunitySourceRefV1Schema).min(1).max(8),
    eligibleAt: timestampSchema,
    expiresAt: timestampSchema,
    rearmPredicate: z.literal('next_eligible_owner_context_after_defer'),
    destinationProposalContract: z.literal('F276.CaptureCandidate.v1'),
    state: z.enum(['deferred', 'reentered', 'expired', 'invalidated']),
  })
  .strict()
  .refine((value) => value.expiresAt > value.eligibleAt, {
    path: ['expiresAt'],
    message: 'expiry must follow re-entry eligibility',
  });

export type DeferredWriteOpportunityReceiptV1 = z.infer<typeof deferredWriteOpportunityReceiptV1Schema>;

export const deferredPersonMemorySourceInputSchema = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal('message').describe('Use the complete owner-authored message as a deferred source.'),
      messageId: boundedString(240).describe(
        'Exact owner-authored message ID; its thread and digest are server-resolved.',
      ),
    })
    .strict(),
  z
    .object({
      kind: z.literal('message_attachment').describe('Use one exact attachment or ASR-bearing block.'),
      messageId: boundedString(240).describe('Exact owner-authored message ID containing the attachment.'),
      attachmentLocator: attachmentLocatorSchema,
      confirmationMessageId: boundedString(240)
        .describe('Exact owner-authored message explicitly confirming transcript or attachment accuracy.')
        .optional(),
    })
    .strict(),
]);

export const deferredPersonMemoryInputSchema = z
  .object({
    subject: boundedString(160).describe(
      'Known person display name or exact private alias; never a relationship fact.',
    ),
    sources: z
      .array(deferredPersonMemorySourceInputSchema)
      .min(1)
      .max(8)
      .describe('One to eight exact owner-visible source coordinates; no excerpts or transcript bodies.'),
    clientRequestId: boundedString(200).describe('Stable idempotency key for this exact defer attempt.'),
    reentryReceipt: z
      .object({
        receiptId: deferredPersonMemoryReceiptIdSchema,
        claimId: boundedString(240),
      })
      .strict()
      .optional()
      .describe(
        'Generation>1 only: exact deferred receipt and active daily-clerk claim being re-armed. The server validates both before replacing its content-free Standing Reflex receipt.',
      ),
    writeOpportunityRef: writeOpportunityRefV1Schema
      .describe(
        'Exact typed ref of the write opportunity being deferred. Supply it only when the prompt showed one; ' +
          'the server re-derives every field from its own delivery evidence and rejects unknown or replayed refs.',
      )
      .optional(),
  })
  .strict();

const deferredRegistryBindingSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('registered_person'), ref: boundedString(240) }).strict(),
  z.object({ kind: z.literal('registered_entity'), ref: boundedString(240) }).strict(),
]);

const resolvedMessageCoordinateSchema = z
  .object({
    kind: z.literal('message'),
    sourceRef: personMemorySourceRefSchema,
    resolvedDigest: digestSchema,
  })
  .strict();

const resolvedAttachmentCoordinateSchema = z
  .object({
    kind: z.literal('message_attachment'),
    sourceRef: personMemorySourceRefSchema,
    attachmentLocator: attachmentLocatorSchema,
    resolvedDigest: digestSchema,
    confirmationSourceRef: personMemorySourceRefSchema.optional(),
  })
  .strict();

export const deferredPersonMemoryResolvedSourceSchema = z.discriminatedUnion('kind', [
  resolvedMessageCoordinateSchema,
  resolvedAttachmentCoordinateSchema,
]);

export const DEFERRED_PERSON_MEMORY_RECEIPT_STATES = [
  'awaiting_confirmation',
  'deferred',
  'claimed',
  'proposed',
  'withdrawn',
] as const;

const receiptBaseSchema = z
  .object({
    receiptId: deferredPersonMemoryReceiptIdSchema,
    ownerUserId: ownerUserIdSchema,
    requesterCatId: requesterCatIdSchema,
    invocationId: boundedString(240).optional(),
    originMessageRef: personMemorySourceRefSchema.optional(),
    subject: boundedString(160).optional(),
    normalizedSubject: boundedString(160).optional(),
    registryBinding: deferredRegistryBindingSchema.optional(),
    sourceCoordinates: z.array(deferredPersonMemoryResolvedSourceSchema).min(1).max(8).optional(),
    sourceBundleDigest: digestSchema.optional(),
    dedupeHash: digestSchema,
    state: z.enum(DEFERRED_PERSON_MEMORY_RECEIPT_STATES),
    claimId: boundedString(240).optional(),
    claimUntil: timestampSchema.optional(),
    proposalId: captureCandidateIdSchema.optional(),
    /**
     * Survivor field: deliberately excluded from the terminal payload-purge set below, because the
     * whole point of the lineage is to remain provable after the receipt reaches `proposed`.
     */
    writeOpportunityLineage: writeOpportunityLineageV1Schema.optional(),
    /** Actionable, content-free Standing Reflex receipt. Purged when the F276 receipt becomes terminal. */
    writeOpportunityReceipt: deferredWriteOpportunityReceiptV1Schema.optional(),
    retention: z.literal('owner_controlled_no_ttl'),
    createdAt: timestampSchema,
    updatedAt: timestampSchema,
  })
  .strict();

type DeferredReceiptShape = z.infer<typeof receiptBaseSchema>;

function validateDeferredReceiptPayload(value: DeferredReceiptShape, actionable: boolean, ctx: z.RefinementCtx): void {
  const payload = [
    value.invocationId,
    value.originMessageRef,
    value.subject,
    value.normalizedSubject,
    value.registryBinding,
    value.sourceCoordinates,
    value.sourceBundleDigest,
  ];
  if (actionable && payload.some((item) => item === undefined)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['subject'],
      message: 'actionable receipt payload is incomplete',
    });
  }
  if (!actionable && (payload.some((item) => item !== undefined) || value.writeOpportunityReceipt !== undefined)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['subject'],
      message: 'terminal receipt payload must be purged',
    });
  }
}

function validateDeferredReceiptLifecycle(value: DeferredReceiptShape, ctx: z.RefinementCtx): void {
  if (value.state === 'claimed' && (!value.claimId || value.claimUntil === undefined)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['claimId'], message: 'claimed receipt requires a lease' });
  }
  if (value.state !== 'claimed' && (value.claimId !== undefined || value.claimUntil !== undefined)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['claimId'],
      message: 'only claimed receipts may retain a lease',
    });
  }
  if ((value.state === 'proposed') !== (value.proposalId !== undefined)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['proposalId'],
      message: 'proposed receipt requires proposalId',
    });
  }
}

function validateDeferredWriteOpportunityBinding(
  value: DeferredReceiptShape,
  actionable: boolean,
  ctx: z.RefinementCtx,
): void {
  if (actionable && (value.writeOpportunityLineage !== undefined) !== (value.writeOpportunityReceipt !== undefined)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['writeOpportunityReceipt'],
      message: 'actionable write-opportunity lineage requires its content-free deferred receipt',
    });
  }
  if (value.writeOpportunityLineage && value.writeOpportunityReceipt) {
    const lineage = value.writeOpportunityLineage;
    const receipt = value.writeOpportunityReceipt;
    const sameIdentity =
      receipt.receiptId === value.receiptId &&
      receipt.reflexId === lineage.reflexId &&
      receipt.reflexVersion === lineage.reflexVersion &&
      receipt.opportunityId === lineage.opportunityId &&
      receipt.dedupeLineage === lineage.dedupeLineage &&
      receipt.generation === lineage.generation;
    if (!sameIdentity || receipt.state !== 'deferred') {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['writeOpportunityReceipt'],
        message: 'write-opportunity receipt must exactly bind the actionable F276 receipt lineage',
      });
    }
  }
}

export const deferredPersonMemoryReceiptSchema = receiptBaseSchema.superRefine((value, ctx) => {
  const actionable = value.state === 'awaiting_confirmation' || value.state === 'deferred' || value.state === 'claimed';
  validateDeferredReceiptPayload(value, actionable, ctx);
  validateDeferredReceiptLifecycle(value, ctx);
  validateDeferredWriteOpportunityBinding(value, actionable, ctx);
});

export type DeferredPersonMemoryInput = z.infer<typeof deferredPersonMemoryInputSchema>;
export type DeferredPersonMemoryReceipt = z.infer<typeof deferredPersonMemoryReceiptSchema>;
export type DeferredPersonMemoryResolvedSource = z.infer<typeof deferredPersonMemoryResolvedSourceSchema>;
export type DeferredPersonMemorySourceInput = z.infer<typeof deferredPersonMemorySourceInputSchema>;
