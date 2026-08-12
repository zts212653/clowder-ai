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
    retention: z.literal('owner_controlled_no_ttl'),
    createdAt: timestampSchema,
    updatedAt: timestampSchema,
  })
  .strict();

export const deferredPersonMemoryReceiptSchema = receiptBaseSchema.superRefine((value, ctx) => {
  const actionable = value.state === 'awaiting_confirmation' || value.state === 'deferred' || value.state === 'claimed';
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
  if (!actionable && payload.some((item) => item !== undefined)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['subject'],
      message: 'terminal receipt payload must be purged',
    });
  }
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
});

export type DeferredPersonMemoryInput = z.infer<typeof deferredPersonMemoryInputSchema>;
export type DeferredPersonMemoryReceipt = z.infer<typeof deferredPersonMemoryReceiptSchema>;
export type DeferredPersonMemoryResolvedSource = z.infer<typeof deferredPersonMemoryResolvedSourceSchema>;
export type DeferredPersonMemorySourceInput = z.infer<typeof deferredPersonMemorySourceInputSchema>;
