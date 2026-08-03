import { captureCandidateIdSchema, humanDispositionLedgerEntrySchema, personIdSchema } from '@cat-cafe/shared';
import { z } from 'zod';

const ownerIdSchema = z.string().trim().min(1).max(120);
const redisKeySchema = z.string().trim().min(1).max(1_000);
const opaqueLineageHandleSchema = z.string().regex(/^f281_lineage_[A-Za-z0-9_-]{43}$/);
const opaqueProposalHandleSchema = z.string().regex(/^f281_proposal_[A-Za-z0-9_-]{43}$/);
const opaqueSupersessionHandleSchema = z.string().regex(/^f281_supersession_[A-Za-z0-9_-]{43}$/);
const opaqueReceiptHandleSchema = z.string().regex(/^f281_receipt_[A-Za-z0-9_-]{43}$/);

export const personMemoryDispositionLineageBindingSchema = z
  .object({
    version: z.literal(1),
    ownerUserId: ownerIdSchema,
    closurePersonId: personIdSchema,
    rootCandidateId: captureCandidateIdSchema,
    currentCandidateId: captureCandidateIdSchema,
    opaqueLineageHandle: opaqueLineageHandleSchema,
    currentOpaqueProposalHandle: opaqueProposalHandleSchema,
    currentOpaqueSupersessionHandle: opaqueSupersessionHandleSchema,
    latestDecisionReceiptHandle: opaqueReceiptHandleSchema.optional(),
  })
  .strict();

export const personMemoryDispositionLineageHandleLocatorSchema = z
  .object({
    bindingKey: redisKeySchema,
    closurePersonId: personIdSchema,
  })
  .strict();

export const personMemoryDispositionDecisionReceiptLocatorSchema = z
  .object({
    bindingKey: redisKeySchema,
    candidateKey: redisKeySchema,
    closurePersonId: personIdSchema,
  })
  .strict();

export const personMemoryProposalDispositionLineageBindingSchema = z
  .object({
    version: z.literal(1),
    ownerUserId: ownerIdSchema,
    purgeScope: z.literal('exact_proposal'),
    rootCandidateId: captureCandidateIdSchema,
    currentCandidateId: captureCandidateIdSchema,
    opaqueLineageHandle: opaqueLineageHandleSchema,
    currentOpaqueProposalHandle: opaqueProposalHandleSchema,
    currentOpaqueSupersessionHandle: opaqueSupersessionHandleSchema,
    latestDecisionReceiptHandle: opaqueReceiptHandleSchema.optional(),
  })
  .strict();

export const personMemoryProposalDispositionLineageHandleLocatorSchema = z
  .object({
    bindingKey: redisKeySchema,
    purgeScope: z.literal('exact_proposal'),
    rootCandidateId: captureCandidateIdSchema,
  })
  .strict();

export const personMemoryProposalDispositionDecisionReceiptLocatorSchema = z
  .object({
    bindingKey: redisKeySchema,
    candidateKey: redisKeySchema,
    purgeScope: z.literal('exact_proposal'),
    rootCandidateId: captureCandidateIdSchema,
  })
  .strict();

export const personMemoryDispositionCandidateMetadataSchema = z
  .object({
    dispositionLineageBindingKey: redisKeySchema,
    humanDispositionLedgerEntry: humanDispositionLedgerEntrySchema.optional(),
  })
  .strict();

export type PersonMemoryDispositionLineageBinding = z.infer<typeof personMemoryDispositionLineageBindingSchema>;
export type PersonMemoryDispositionLineageHandleLocator = z.infer<
  typeof personMemoryDispositionLineageHandleLocatorSchema
>;
export type PersonMemoryDispositionDecisionReceiptLocator = z.infer<
  typeof personMemoryDispositionDecisionReceiptLocatorSchema
>;
export type PersonMemoryProposalDispositionLineageBinding = z.infer<
  typeof personMemoryProposalDispositionLineageBindingSchema
>;
export type PersonMemoryProposalDispositionLineageHandleLocator = z.infer<
  typeof personMemoryProposalDispositionLineageHandleLocatorSchema
>;
export type PersonMemoryProposalDispositionDecisionReceiptLocator = z.infer<
  typeof personMemoryProposalDispositionDecisionReceiptLocatorSchema
>;

export function parseDispositionLineageBinding(raw: string | null): PersonMemoryDispositionLineageBinding | null {
  if (!raw) return null;
  try {
    return personMemoryDispositionLineageBindingSchema.parse(JSON.parse(raw));
  } catch {
    return null;
  }
}

export function parseDispositionLineageHandleLocator(
  raw: string | null,
): PersonMemoryDispositionLineageHandleLocator | null {
  if (!raw) return null;
  try {
    return personMemoryDispositionLineageHandleLocatorSchema.parse(JSON.parse(raw));
  } catch {
    return null;
  }
}

export function parseDispositionDecisionReceiptLocator(
  raw: string | null,
): PersonMemoryDispositionDecisionReceiptLocator | null {
  if (!raw) return null;
  try {
    return personMemoryDispositionDecisionReceiptLocatorSchema.parse(JSON.parse(raw));
  } catch {
    return null;
  }
}

export function parseProposalDispositionLineageBinding(
  raw: string | null,
): PersonMemoryProposalDispositionLineageBinding | null {
  if (!raw) return null;
  try {
    return personMemoryProposalDispositionLineageBindingSchema.parse(JSON.parse(raw));
  } catch {
    return null;
  }
}

export function parseProposalDispositionLineageHandleLocator(
  raw: string | null,
): PersonMemoryProposalDispositionLineageHandleLocator | null {
  if (!raw) return null;
  try {
    return personMemoryProposalDispositionLineageHandleLocatorSchema.parse(JSON.parse(raw));
  } catch {
    return null;
  }
}

export function parseProposalDispositionDecisionReceiptLocator(
  raw: string | null,
): PersonMemoryProposalDispositionDecisionReceiptLocator | null {
  if (!raw) return null;
  try {
    return personMemoryProposalDispositionDecisionReceiptLocatorSchema.parse(JSON.parse(raw));
  } catch {
    return null;
  }
}
