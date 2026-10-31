import { z } from 'zod';

export const prefixedId = (prefix: string) =>
  z
    .string()
    .trim()
    .min(prefix.length + 1)
    .max(160)
    .regex(new RegExp(`^${prefix}[A-Za-z0-9][A-Za-z0-9._:-]*$`));

export const boundedString = (max: number) => z.string().trim().min(1).max(max);
export const timestampSchema = z.number().int().nonnegative().finite();
export const ownerUserIdSchema = boundedString(200);
export const requesterCatIdSchema = boundedString(120);

export const personIdSchema = prefixedId('person_').brand<'PersonId'>();
export const personRelationshipIdSchema = prefixedId('relationship_').brand<'PersonRelationshipId'>();
export const personClaimIdSchema = prefixedId('person_claim_').brand<'PersonClaimId'>();
export const interactionEventIdSchema = prefixedId('person_event_').brand<'InteractionEventId'>();
export const captureCandidateIdSchema = prefixedId('person_candidate_').brand<'CaptureCandidateId'>();
export const candidateClaimDraftIdSchema = prefixedId('person_draft_').brand<'CandidateClaimDraftId'>();
export const personForgetRequestIdSchema = prefixedId('person_forget_').brand<'PersonForgetRequestId'>();
export const personSuppressionTokenIdSchema = prefixedId('person_suppression_').brand<'PersonSuppressionTokenId'>();

export const personMemorySourceRefSchema = z
  .object({
    kind: z.literal('message'),
    threadId: boundedString(200),
    messageId: boundedString(240),
  })
  .strict();

export type PersonId = z.infer<typeof personIdSchema>;
export type PersonRelationshipId = z.infer<typeof personRelationshipIdSchema>;
export type PersonClaimId = z.infer<typeof personClaimIdSchema>;
export type InteractionEventId = z.infer<typeof interactionEventIdSchema>;
export type CaptureCandidateId = z.infer<typeof captureCandidateIdSchema>;
export type CandidateClaimDraftId = z.infer<typeof candidateClaimDraftIdSchema>;
export type PersonMemorySourceRef = z.infer<typeof personMemorySourceRefSchema>;
