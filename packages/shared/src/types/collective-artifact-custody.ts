import { z } from 'zod';

const id = z.string().trim().min(1).max(256);
const positive = z.number().int().positive().safe();
const digest = z.string().regex(/^sha256:[a-f0-9]{64}$/);
/** Raw page bytes leave room for base64 and typed envelope inside a 64 KiB relay message. */
export const COLLECTIVE_CUSTODY_PAGE_BYTES = 32768;
export const COLLECTIVE_CUSTODY_MAX_BYTES = 16 * 1024 * 1024;
export const COLLECTIVE_CUSTODY_MAX_PAGES = 512;
export const collectiveCustodyManifestSchema = z
  .object({
    digest,
    totalBytes: positive.max(COLLECTIVE_CUSTODY_MAX_BYTES),
    pageCount: positive.max(COLLECTIVE_CUSTODY_MAX_PAGES),
  })
  .strict()
  .refine((value) => value.pageCount === Math.ceil(value.totalBytes / COLLECTIVE_CUSTODY_PAGE_BYTES));
export const collectiveCustodyVersionSchema = z
  .object({ contentRef: id, ownerRevision: positive, blobDigest: digest, receiptRef: id })
  .strict();
export const collectiveCustodyPreparedSchema = z
  .object({
    preparedRef: id,
    manifest: collectiveCustodyManifestSchema,
    version: collectiveCustodyVersionSchema,
    ownerScopeRef: id,
  })
  .strict();
export const collectiveCustodyReadySchema = z
  .object({
    readyRef: id,
    preparedRef: id,
    manifestDigest: digest,
    ownerScopeRef: id,
  })
  .strict();
/** Endpoint-only, content-free state. It is never part of the Human artifact projection or context bridge. */
export const collectiveCustodyTransferSchema = z
  .object({
    v: z.literal(1),
    transferId: id,
    serviceInstanceId: id,
    collectiveId: id,
    artifactId: id,
    sourceEventId: id,
    publishedByHumanId: id,
    sourceConnectionId: id,
    sourceEndpointId: id,
    sourceHumanId: id,
    targetConnectionId: id,
    targetEndpointId: id,
    targetHumanId: id,
    expectedCustodyRevision: positive,
    state: z.enum(['offered', 'source_prepared', 'target_ready', 'committed', 'cancelled']),
    version: collectiveCustodyVersionSchema,
    prepared: collectiveCustodyPreparedSchema.optional(),
    ready: collectiveCustodyReadySchema.optional(),
    offeredByHumanId: id,
    offerRequestId: id,
    createdAt: z.string().datetime(),
    updatedAt: z.string().datetime(),
    sourceFinalized: z.boolean().default(false),
    targetFinalized: z.boolean().default(false),
  })
  .strict()
  .superRefine((value, context) => {
    if (
      (['source_prepared', 'target_ready', 'committed'].includes(value.state) && !value.prepared) ||
      (['target_ready', 'committed'].includes(value.state) && !value.ready)
    )
      context.addIssue({ code: z.ZodIssueCode.custom, message: 'Transfer phase requires exact owner proofs' });
  });
export type CollectiveArtifactCustodyTransfer = z.infer<typeof collectiveCustodyTransferSchema>;
export type CollectiveCustodyManifest = z.infer<typeof collectiveCustodyManifestSchema>;
export type CollectiveCustodyPrepared = z.infer<typeof collectiveCustodyPreparedSchema>;
export type CollectiveCustodyReady = z.infer<typeof collectiveCustodyReadySchema>;
export const collectiveCustodyPageSchema = z
  .object({
    transferId: id,
    index: z
      .number()
      .int()
      .nonnegative()
      .max(COLLECTIVE_CUSTODY_MAX_PAGES - 1),
    digest,
    base64: z
      .string()
      .min(1)
      .max(Math.ceil(COLLECTIVE_CUSTODY_PAGE_BYTES / 3) * 4),
  })
  .strict();
export type CollectiveCustodyPage = z.infer<typeof collectiveCustodyPageSchema>;
export const collectiveCustodyEndpointSchema = z
  .object({ serviceInstanceId: id, collectiveId: id, connectionId: id })
  .strict();
export const collectiveCustodyTargetSchema = collectiveCustodyEndpointSchema
  .extend({ artifactId: id, transferId: id })
  .strict();
export const prepareCollectiveCustodySchema = collectiveCustodyTargetSchema
  .extend({ proof: collectiveCustodyPreparedSchema })
  .strict();
export const readyCollectiveCustodySchema = collectiveCustodyTargetSchema
  .extend({ proof: collectiveCustodyReadySchema })
  .strict();
export const cancelCollectiveCustodySchema = collectiveCustodyTargetSchema.omit({ connectionId: true }).strict();
export const finalizeCollectiveCustodySchema = collectiveCustodyTargetSchema
  .extend({ outcome: z.enum(['committed', 'cancelled']) })
  .strict();
export const authorizeCollectiveCustodySchema = collectiveCustodyTargetSchema
  .extend({ operation: z.enum(['prepareSource', 'readPage', 'stageTarget', 'attestReady', 'finalize']) })
  .strict();
