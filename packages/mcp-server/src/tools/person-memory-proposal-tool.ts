import {
  candidateClaimDraftSchema,
  candidateInteractionProposalSchema,
  candidateRelationshipDraftSchema,
  captureCandidateIdSchema,
  createTemporalValueSchema,
  deferredPersonMemoryReceiptIdSchema,
  personIdentityDraftSchema,
  personIdSchema,
  personMemorySourceBundleInputSchema,
  writeOpportunityRefV1Schema,
} from '@cat-cafe/shared';
import { z } from 'zod';

const claimInputSchema = candidateClaimDraftSchema.omit({ draftId: true, decision: true });
const relationshipInputSchema = candidateRelationshipDraftSchema.omit({ draftId: true, decision: true });
const interactionProposalBaseSchema = candidateInteractionProposalSchema.innerType();
const interactionInputSchema = interactionProposalBaseSchema
  .extend({
    payload: interactionProposalBaseSchema.shape.payload.extend({
      occurredAt: createTemporalValueSchema().optional(),
      duration: createTemporalValueSchema().optional(),
    }),
  })
  .superRefine((value, ctx) => {
    const validated = candidateInteractionProposalSchema.safeParse(value);
    if (validated.success) return;
    for (const issue of validated.error.issues) {
      ctx.addIssue(issue);
    }
  });

export const proposePersonMemoryInputSchema = {
  person: personIdentityDraftSchema.describe(
    'One named third-party person. Aliases are private to the authenticated owner; an optional workspace link is only a locator.',
  ),
  targetPersonId: personIdSchema
    .optional()
    .describe('Optional exact active private person ID when updating an already materialized person.'),
  replacesProposalId: captureCandidateIdSchema
    .optional()
    .describe(
      'Exact pending/not-now F276 proposal ID to replace with this corrected card. The server anchors the new card and withdraws the old one atomically.',
    ),
  deferredReceipt: z
    .object({
      receiptId: deferredPersonMemoryReceiptIdSchema,
      claimId: z.string().trim().min(1).max(240).describe('Exact active daily-clerk claim fence for the receipt.'),
    })
    .strict()
    .optional()
    .describe(
      'Daily-clerk lineage only: exact claimed deferred receipt and claim lease. The server verifies owner, cat, subject, sources, and active claim before creating a card.',
    ),
  claims: z
    .array(claimInputSchema)
    .max(3)
    .default([])
    .describe('0-3 owner-reported facts or owner assessments. Agent inference is intentionally not accepted.'),
  relationship: relationshipInputSchema
    .optional()
    .describe('Optional first-class owner-to-person relationship proposal.'),
  interaction: interactionInputSchema
    .optional()
    .describe(
      'Optional append-only interaction event with 1-8 ordered owner-visible message evidence sources, including exact messages from other threads. Preserve approximate or conflicting time explicitly.',
    ),
  sourceBundle: personMemorySourceBundleInputSchema.describe(
    'Typed evidence sources plus per-claim/relationship/interaction-field assertion roles. Locators are optimistic pins; the server re-resolves owner, actual source thread, visibility and digest before staging and again before publication.',
  ),
  sourceMessageId: z
    .string()
    .min(1)
    .optional()
    .describe(
      'Optional exact owner-authored source from any owner-visible thread. Historical sources must contain every claim/relationship evidence excerpt and pass visibility checks.',
    ),
  writeOpportunityRef: writeOpportunityRefV1Schema
    .optional()
    .describe(
      'Exact content-free opportunityId, dedupeLineage, and generation printed in an ASR person-memory prompt. Pass it verbatim so the server can bind this proposal disposition to that delivered opportunity.',
    ),
  clientRequestId: z.string().min(1).max(200).optional().describe('Optional idempotency key.'),
};
