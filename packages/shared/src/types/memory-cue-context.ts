import { z } from 'zod';

const evidenceRef = z.string().trim().min(1).max(500);
const fresh = {
  reason: z.enum(['no_prior_session', 'resume_rejected', 'resume_failed']),
  evidenceRef,
  runtimeSessionId: evidenceRef.optional(),
};

/** Closed, content-free evidence from ContextEpochOwner; never inferred from cold/prose. */
export const contextSourceEvidenceV1Schema = z.discriminatedUnion('transition', [
  z.object({ transition: z.literal('fresh'), ...fresh }).strict(),
  z.object({ transition: z.literal('scope_first_seen'), ...fresh }).strict(),
  z
    .object({
      transition: z.literal('replaced'),
      reason: z.literal('runtime_replaced'),
      evidenceRef,
      runtimeSessionId: evidenceRef,
    })
    .strict(),
  z
    .object({
      transition: z.literal('context_compacted'),
      evidenceRef,
      eventId: evidenceRef,
      runtimeSessionId: evidenceRef,
    })
    .strict(),
]);

export const contextSourcePayloadV1Schema = z
  .object({
    sourceMessageId: z.string().trim().min(1).max(200),
    contextEpoch: z.number().int().positive(),
    evidence: contextSourceEvidenceV1Schema,
  })
  .strict();

export type ContextSourceEvidenceV1 = z.infer<typeof contextSourceEvidenceV1Schema>;
