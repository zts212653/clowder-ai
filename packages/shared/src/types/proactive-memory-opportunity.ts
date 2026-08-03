import { z } from 'zod';

export const PROACTIVE_MEMORY_ABSTENTION_REASON_CODES = [
  'not_continuity_valued',
  'insufficient_owner_evidence',
  'bad_timing',
  'authorization_boundary',
  'already_registered_or_pending',
  'privacy_boundary',
] as const;

export type ProactiveMemoryOpportunityRef = `opp_${string}`;
export type ProactiveMemoryAbstentionReasonCode = (typeof PROACTIVE_MEMORY_ABSTENTION_REASON_CODES)[number];

export const proactiveMemoryOpportunityRefSchema = z
  .string()
  .regex(/^opp_[a-f0-9]{32}$/)
  .transform((value) => value as ProactiveMemoryOpportunityRef);

export const proactiveMemoryAbstentionReasonCodeSchema = z.enum(PROACTIVE_MEMORY_ABSTENTION_REASON_CODES);

export const proactiveMemoryAbstentionInputSchema = z
  .object({
    reasonCode: proactiveMemoryAbstentionReasonCodeSchema,
  })
  .strict();

const proactiveMemoryProposalEpisodeSchema = z
  .object({
    opportunityRef: proactiveMemoryOpportunityRefSchema,
    disposition: z.literal('propose'),
    reasonCode: z.literal('proposal_submitted'),
  })
  .strict();

const proactiveMemoryAbstentionEpisodeSchema = z
  .object({
    opportunityRef: proactiveMemoryOpportunityRefSchema,
    disposition: z.literal('abstain'),
    reasonCode: proactiveMemoryAbstentionReasonCodeSchema,
  })
  .strict();

export const proactiveMemoryOpportunityEpisodeSchema = z.discriminatedUnion('disposition', [
  proactiveMemoryProposalEpisodeSchema,
  proactiveMemoryAbstentionEpisodeSchema,
]);

export type ProactiveMemoryAbstentionInput = z.infer<typeof proactiveMemoryAbstentionInputSchema>;
export type ProactiveMemoryOpportunityEpisode = z.infer<typeof proactiveMemoryOpportunityEpisodeSchema>;
