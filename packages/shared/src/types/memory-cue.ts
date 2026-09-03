import { z } from 'zod';
import { CURRENT_RELATIONSHIP_PROFILE_URI } from '../profile-contract.js';

export const RECALL_OPPORTUNITY_CATALOG_VERSION = 3 as const;

export const RECALL_RESOLVER_FAMILIES = [
  'person_entity',
  'operational_precedent',
  'taste',
  'profile',
  'event',
  'project_knowledge',
] as const;

export const MEMORY_CUE_INVALIDATORS = [
  'source_corrected',
  'source_forgotten',
  'scope_revoked',
  'superseded',
  'expired',
] as const;

export const RECALL_OPPORTUNITY_V1_PAIRS = Object.freeze([
  Object.freeze({ kind: 'subject_seen' as const, producer: 'entity_nudge' as const }),
  Object.freeze({ kind: 'delivery_decision' as const, producer: 'github_ci' as const }),
  Object.freeze({
    kind: 'judgment_surface_entered' as const,
    producer: 'workflow_sop' as const,
  }),
  Object.freeze({
    kind: 'approved_taste_invoked' as const,
    producer: 'owner_message' as const,
  }),
  Object.freeze({
    kind: 'profile_revision_available' as const,
    producer: 'profile_repository' as const,
  }),
  Object.freeze({
    kind: 'recent_event_available' as const,
    producer: 'event_memory' as const,
  }),
]);

const boundedIdentifier = (max: number) => z.string().trim().min(1).max(max);
const timestampSchema = z.number().int().nonnegative().finite();

export const recallScopeV1Schema = z
  .object({
    ownerUserId: boundedIdentifier(160),
    threadId: boundedIdentifier(160),
    invocationId: boundedIdentifier(160),
  })
  .strict();

const opportunityBaseShape = {
  v: z.literal(1),
  opportunityId: boundedIdentifier(200),
  consumer: z.literal('agent_route'),
  scope: recallScopeV1Schema,
  occurredAt: timestampSchema,
};

export const subjectSeenOpportunityV1Schema = z
  .object({
    ...opportunityBaseShape,
    kind: z.literal('subject_seen'),
    producer: z.literal('entity_nudge'),
    payload: z
      .object({
        entityId: boundedIdentifier(200),
        matchedAlias: boundedIdentifier(160),
        sourceMessageId: boundedIdentifier(200),
      })
      .strict(),
  })
  .strict();

export const deliveryDecisionOpportunityV1Schema = z
  .object({
    ...opportunityBaseShape,
    kind: z.literal('delivery_decision'),
    producer: z.literal('github_ci'),
    payload: z
      .object({
        repoFullName: z
          .string()
          .regex(/^[^/\s]+\/[^/\s]+$/)
          .max(240),
        prNumber: z.number().int().positive(),
        headSha: z.string().regex(/^[0-9a-f]{40}$/),
        phase: z.literal('merge_gate'),
        gateOutcome: z.literal('source_evidence_complete'),
        externalCondition: z.literal('billing_spending_limit_zero_step'),
        candidateAction: z.literal('merge'),
        sourceMessageId: boundedIdentifier(200),
      })
      .strict(),
  })
  .strict();

/** Server-private transport frame; sourceMessageId and execution scope are rebound after queue admission. */
export const deliveryDecisionCueCarrierV1Schema = z
  .object({
    v: z.literal(1),
    producer: z.literal('github_ci'),
    producerProvenance: z.literal('server_github_ci'),
    repoFullName: z
      .string()
      .regex(/^[^/\s]+\/[^/\s]+$/)
      .max(240),
    prNumber: z.number().int().positive(),
    headSha: z.string().regex(/^[0-9a-f]{40}$/),
    phase: z.literal('merge_gate'),
    gateOutcome: z.literal('source_evidence_complete'),
    externalCondition: z.literal('billing_spending_limit_zero_step'),
    candidateAction: z.literal('merge'),
    occurredAt: timestampSchema,
  })
  .strict();

export const judgmentSurfaceEnteredOpportunityV1Schema = z
  .object({
    ...opportunityBaseShape,
    kind: z.literal('judgment_surface_entered'),
    producer: z.literal('workflow_sop'),
    payload: z
      .object({
        stage: z.enum(['quality_gate', 'review']),
        selectedSkill: z.enum(['writing-plans', 'co-creation-docs', 'fresh-context-review', 'request-review']),
        selectionSource: z.enum(['override', 'explicit_prompt_tag']),
        featureId: z.string().regex(/^F\d{3,}$/),
      })
      .strict(),
  })
  .strict();

export const approvedTasteInvokedOpportunityV1Schema = z
  .object({
    ...opportunityBaseShape,
    kind: z.literal('approved_taste_invoked'),
    producer: z.literal('owner_message'),
    payload: z
      .object({
        triggerKey: z.literal('ELI5'),
        sourceMessageId: boundedIdentifier(200),
      })
      .strict(),
  })
  .strict();

export const profileRevisionAvailableOpportunityV1Schema = z
  .object({
    ...opportunityBaseShape,
    kind: z.literal('profile_revision_available'),
    producer: z.literal('profile_repository'),
    payload: z
      .object({
        profileUri: z.literal(CURRENT_RELATIONSHIP_PROFILE_URI),
        sourceRevision: boundedIdentifier(200),
      })
      .strict(),
  })
  .strict();

export const recentEventAvailableOpportunityV1Schema = z
  .object({
    ...opportunityBaseShape,
    kind: z.literal('recent_event_available'),
    producer: z.literal('event_memory'),
    payload: z
      .object({
        eventId: boundedIdentifier(200),
        subjectThreadId: boundedIdentifier(160),
        sourceRevision: boundedIdentifier(200),
      })
      .strict(),
  })
  .strict();

export const recallOpportunityV1Schema = z.discriminatedUnion('kind', [
  subjectSeenOpportunityV1Schema,
  deliveryDecisionOpportunityV1Schema,
  judgmentSurfaceEnteredOpportunityV1Schema,
  approvedTasteInvokedOpportunityV1Schema,
  profileRevisionAvailableOpportunityV1Schema,
  recentEventAvailableOpportunityV1Schema,
]);

const memoryCueInvalidatorsSchema = z.tuple([
  z.literal('source_corrected'),
  z.literal('source_forgotten'),
  z.literal('scope_revoked'),
  z.literal('superseded'),
  z.literal('expired'),
]);

export const cueEnvelopeV1Schema = z
  .object({
    v: z.literal(1),
    cueId: boundedIdentifier(200),
    opportunityId: boundedIdentifier(200),
    catalogVersion: z.literal(RECALL_OPPORTUNITY_CATALOG_VERSION),
    resolverFamily: z.enum(RECALL_RESOLVER_FAMILIES),
    resolverVersion: z.number().int().positive(),
    whyNow: boundedIdentifier(400),
    title: boundedIdentifier(160),
    summary: boundedIdentifier(600),
    source: z
      .object({
        anchor: boundedIdentifier(500),
        revision: boundedIdentifier(200),
        asOf: timestampSchema.optional(),
        visibility: z.enum(['owner_public', 'owner_private']),
      })
      .strict(),
    drill: z
      .object({
        family: z.enum(['person_memory', 'evidence', 'taste', 'profile', 'event']),
        handle: boundedIdentifier(2_000),
      })
      .strict(),
    scope: recallScopeV1Schema,
    invalidators: memoryCueInvalidatorsSchema,
    expiresAt: timestampSchema.optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.resolverFamily === 'person_entity' && value.source.asOf === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['source', 'asOf'],
        message: 'person memory cues require a source asOf coordinate',
      });
    }
  });

export type RecallScopeV1 = z.infer<typeof recallScopeV1Schema>;
export type SubjectSeenOpportunityV1 = z.infer<typeof subjectSeenOpportunityV1Schema>;
export type DeliveryDecisionOpportunityV1 = z.infer<typeof deliveryDecisionOpportunityV1Schema>;
export type DeliveryDecisionCueCarrierV1 = z.infer<typeof deliveryDecisionCueCarrierV1Schema>;
export type JudgmentSurfaceEnteredOpportunityV1 = z.infer<typeof judgmentSurfaceEnteredOpportunityV1Schema>;
export type ApprovedTasteInvokedOpportunityV1 = z.infer<typeof approvedTasteInvokedOpportunityV1Schema>;
export type ProfileRevisionAvailableOpportunityV1 = z.infer<typeof profileRevisionAvailableOpportunityV1Schema>;
export type RecentEventAvailableOpportunityV1 = z.infer<typeof recentEventAvailableOpportunityV1Schema>;
export type RecallOpportunityV1 = z.infer<typeof recallOpportunityV1Schema>;
export type CueEnvelopeV1 = z.infer<typeof cueEnvelopeV1Schema>;
export type RecallResolverFamily = (typeof RECALL_RESOLVER_FAMILIES)[number];
export type MemoryCueInvalidator = (typeof MEMORY_CUE_INVALIDATORS)[number];

const MEMORY_CUE_DRILL_FAMILY_BY_RESOLVER = Object.freeze({
  person_entity: 'person_memory' as const,
  operational_precedent: 'evidence' as const,
  taste: 'taste' as const,
  profile: 'profile' as const,
  event: 'event' as const,
  project_knowledge: null,
});

export function memoryCueDrillFamilyForResolver(
  resolverFamily: RecallResolverFamily,
): CueEnvelopeV1['drill']['family'] | null {
  return MEMORY_CUE_DRILL_FAMILY_BY_RESOLVER[resolverFamily];
}

export function isRecallOpportunityV1(value: unknown): value is RecallOpportunityV1 {
  return recallOpportunityV1Schema.safeParse(value).success;
}

export function isCueEnvelopeV1(value: unknown): value is CueEnvelopeV1 {
  return cueEnvelopeV1Schema.safeParse(value).success;
}
