import { z } from 'zod';
import {
  boundedString,
  candidateClaimDraftIdSchema,
  captureCandidateIdSchema,
  interactionEventIdSchema,
  ownerUserIdSchema,
  type PersonMemorySourceRef,
  personClaimIdSchema,
  personForgetRequestIdSchema,
  personIdSchema,
  personMemorySourceRefSchema,
  personRelationshipIdSchema,
  personSuppressionTokenIdSchema,
  requesterCatIdSchema,
  timestampSchema,
} from './person-memory-base.js';
import {
  personMemoryInteractionEvidenceFieldSchema,
  personMemoryResolvedSourceBundleSchema,
} from './person-memory-source-bundle.js';
import {
  deferredPersonMemoryReceiptIdSchema,
  writeOpportunityLineageV1Schema,
} from './proactive-memory-deferred-receipt.js';

export type {
  CandidateClaimDraftId,
  CaptureCandidateId,
  InteractionEventId,
  PersonClaimId,
  PersonId,
  PersonMemorySourceRef,
  PersonRelationshipId,
} from './person-memory-base.js';
export {
  candidateClaimDraftIdSchema,
  captureCandidateIdSchema,
  interactionEventIdSchema,
  personClaimIdSchema,
  personForgetRequestIdSchema,
  personIdSchema,
  personMemorySourceRefSchema,
  personRelationshipIdSchema,
  personSuppressionTokenIdSchema,
} from './person-memory-base.js';
export type {
  PersonMemoryAssertionBinding,
  PersonMemoryAssertionMatrixInput,
  PersonMemoryAssertionRole,
  PersonMemoryResolvedSourceBundle,
  PersonMemorySourceBundleInput,
  PersonMemorySourceInput,
  ResolvedPersonMemoryAssertionBinding,
  ResolvedPersonMemorySource,
} from './person-memory-source-bundle.js';
export {
  PERSON_MEMORY_INTERACTION_EVIDENCE_FIELDS,
  personMemoryAssertionBindingSchema,
  personMemoryAssertionRoleSchema,
  personMemoryInteractionEvidenceFieldSchema,
  personMemoryResolvedSourceBundleSchema,
  personMemorySourceBundleInputSchema,
  personMemorySourceInputSchema,
  resolvedPersonMemoryAssertionBindingSchema,
  resolvedPersonMemorySourceSchema,
  validatePersonMemoryAssertionMatrix,
} from './person-memory-source-bundle.js';

/**
 * F276 owner-private people and relationship memory.
 *
 * These schemas are the untrusted ingress boundary shared by API, MCP and Web.
 * Canonical store keys always add the server-derived owner scope separately.
 */

export const PERSON_MEMORY_LIMITS = Object.freeze({
  maxClaimsPerCandidate: 3,
  maxCandidateCardTokens: 240,
  maxEvidenceExcerptTokens: 24,
  maxEvidenceExcerptAggregateTokens: 64,
  maxRelationshipCardTokens: 160,
  maxFactsPerRelationshipCard: 3,
  maxProvenanceRefsPerCard: 3,
  maxDrillTokensPerCall: 500,
  maxDrillsPerPersonPerTurn: 3,
  maxPersonMemoryTokensPerTurn: 1_200,
});

export const PERSON_MEMORY_CANDIDATE_STATES = [
  'pending_approval',
  'not_now',
  'partially_materialized',
  'materialized',
  'rejected',
  'withdrawn',
] as const;

function isJsonValue(value: unknown): boolean {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return true;
  if (typeof value === 'number') return Number.isFinite(value);
  if (Array.isArray(value)) return value.every(isJsonValue);
  if (!value || typeof value !== 'object') return false;
  return Object.values(value as Record<string, unknown>).every(isJsonValue);
}

export const jsonValueSchema = z.unknown().refine(isJsonValue, 'value must be JSON-serializable');

export function createTemporalValueSchema() {
  const freshTemporalAlternativeSchema = z
    .object({
      label: boundedString(80),
      value: boundedString(160),
    })
    .strict();
  return z.discriminatedUnion('kind', [
    z
      .object({
        kind: z.literal('exact'),
        value: boundedString(160),
      })
      .strict(),
    z
      .object({
        kind: z.literal('approximate'),
        raw: boundedString(240),
        qualifier: z.enum(['about', 'before', 'after', 'range', 'unknown']),
        earliest: boundedString(160).optional(),
        latest: boundedString(160).optional(),
      })
      .strict(),
    z
      .object({
        kind: z.literal('conflict'),
        raw: boundedString(240),
        alternatives: z.array(freshTemporalAlternativeSchema).min(2).max(4),
      })
      .strict(),
  ]);
}

export const temporalValueSchema = createTemporalValueSchema();

const reportedFactSchema = z
  .object({
    kind: z.literal('reported_fact'),
    predicate: boundedString(160),
    value: jsonValueSchema,
    assertedBy: z.literal('owner'),
  })
  .strict();

const userAssessmentSchema = z
  .object({
    kind: z.literal('user_assessment'),
    statement: boundedString(800),
    assertedBy: z.literal('owner'),
    stance: z.enum(['endorsed', 'rejected', 'uncertain']),
  })
  .strict();

export const materializableClaimPayloadSchema = z.discriminatedUnion('kind', [
  reportedFactSchema,
  userAssessmentSchema,
]);

const redactedClaimPayloadSchema = z.object({ kind: z.literal('redacted') }).strict();
const canonicalClaimPayloadSchema = z.union([materializableClaimPayloadSchema, redactedClaimPayloadSchema]);

const cardApprovalAuthoritySchema = z
  .object({
    kind: z.literal('card_approval'),
    candidateId: captureCandidateIdSchema,
    draftId: candidateClaimDraftIdSchema,
    authorizedAt: timestampSchema,
  })
  .strict();

const explicitMemoryCommandAuthoritySchema = z
  .object({
    kind: z.literal('explicit_memory_command'),
    sourceMessageRef: personMemorySourceRefSchema,
    boundedTarget: boundedString(240),
    authorizedAt: timestampSchema,
  })
  .strict();

const existingTruthRefSchema = z.union([personClaimIdSchema, personRelationshipIdSchema, interactionEventIdSchema]);

const anchoredCorrectionAuthoritySchema = z
  .object({
    kind: z.literal('anchored_correction'),
    sourceMessageRef: personMemorySourceRefSchema,
    existingTruthRef: existingTruthRefSchema,
    authorizedAt: timestampSchema,
  })
  .strict();

export const materializationAuthoritySchema = z.discriminatedUnion('kind', [
  cardApprovalAuthoritySchema,
  explicitMemoryCommandAuthoritySchema,
  anchoredCorrectionAuthoritySchema,
]);

export const workspaceEntityLinkSchema = z
  .object({
    entityRef: boundedString(240),
    state: z.enum(['linked', 'stale', 'deleted']),
    checkedAt: timestampSchema,
    supersededByEntityRef: boundedString(240).optional(),
  })
  .strict();

export const personIdentitySchema = z
  .object({
    personId: personIdSchema,
    ownerUserId: ownerUserIdSchema,
    displayName: boundedString(160),
    privateAliases: z.array(boundedString(160)).min(1).max(20),
    workspaceEntityLink: workspaceEntityLinkSchema.optional(),
    status: z.enum(['active', 'retired']),
    materializedBy: materializationAuthoritySchema,
    createdAt: timestampSchema,
    sourceRefs: z.array(personMemorySourceRefSchema).min(1).max(8),
    typedProvenance: personMemoryResolvedSourceBundleSchema.optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (new Set(value.privateAliases).size !== value.privateAliases.length) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['privateAliases'],
        message: 'private aliases must be unique',
      });
    }
  });

export const personClaimVersionSchema = z
  .object({
    claimId: personClaimIdSchema,
    personId: personIdSchema,
    ownerUserId: ownerUserIdSchema,
    payload: canonicalClaimPayloadSchema,
    status: z.enum(['current', 'superseded', 'retired', 'redacted']),
    validFrom: timestampSchema.optional(),
    validTo: timestampSchema.optional(),
    recordedAt: timestampSchema,
    sourceRefs: z.array(personMemorySourceRefSchema).max(8),
    typedProvenance: personMemoryResolvedSourceBundleSchema.optional(),
    materializedBy: materializationAuthoritySchema,
    supersedesClaimId: personClaimIdSchema.optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.validFrom !== undefined && value.validTo !== undefined && value.validTo < value.validFrom) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['validTo'],
        message: 'validTo cannot be before validFrom',
      });
    }
    if (value.supersedesClaimId === value.claimId) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['supersedesClaimId'],
        message: 'a claim cannot supersede itself',
      });
    }
    if (value.status === 'redacted') {
      if (value.payload.kind !== 'redacted' || value.sourceRefs.length !== 0 || value.typedProvenance !== undefined) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['payload'],
          message: 'redacted claims must purge payload and source refs',
        });
      }
    } else if (value.payload.kind === 'redacted' || value.sourceRefs.length === 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['sourceRefs'],
        message: 'non-redacted claims require materializable payload and provenance',
      });
    }
  });

export const personRelationshipTransitionSchema = z
  .object({
    status: z.enum(['current', 'former', 'unknown']),
    recordedAt: timestampSchema,
    materializedBy: materializationAuthoritySchema,
    sourceRefs: z.array(personMemorySourceRefSchema).max(8),
    typedProvenance: personMemoryResolvedSourceBundleSchema.optional(),
  })
  .strict();

export const personRelationshipSchema = z
  .object({
    relationshipId: personRelationshipIdSchema,
    ownerUserId: ownerUserIdSchema,
    personId: personIdSchema,
    status: z.enum(['current', 'former', 'unknown']),
    materializedBy: materializationAuthoritySchema,
    createdAt: timestampSchema,
    sourceRefs: z.array(personMemorySourceRefSchema).min(1).max(8),
    typedProvenance: personMemoryResolvedSourceBundleSchema.optional(),
    transitions: z.array(personRelationshipTransitionSchema).min(1).max(200),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.transitions[0]?.recordedAt !== value.createdAt) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['transitions', 0, 'recordedAt'],
        message: 'the first relationship transition must match createdAt',
      });
    }
    if (value.transitions[value.transitions.length - 1]?.status !== value.status) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['status'],
        message: 'relationship status must match the latest transition',
      });
    }
    for (let index = 1; index < value.transitions.length; index += 1) {
      const currentTransition = value.transitions[index];
      const previousTransition = value.transitions[index - 1];
      if (currentTransition && previousTransition && currentTransition.recordedAt < previousTransition.recordedAt) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['transitions', index, 'recordedAt'],
          message: 'relationship transitions must be append-ordered',
        });
      }
    }
  });

export const interactionEventSchema = z
  .object({
    eventId: interactionEventIdSchema,
    relationshipId: personRelationshipIdSchema,
    ownerUserId: ownerUserIdSchema,
    occurredAt: temporalValueSchema.optional(),
    duration: temporalValueSchema.optional(),
    recordedAt: timestampSchema,
    eventKind: z.enum(['conversation', 'meeting', 'message', 'milestone', 'other']),
    headline: boundedString(240),
    importanceOrTopic: boundedString(400).optional(),
    uncertaintyNotes: z.array(boundedString(240)).max(4).optional(),
    sourceRefs: z.array(personMemorySourceRefSchema).min(1).max(8),
    typedProvenance: personMemoryResolvedSourceBundleSchema.optional(),
    materializedBy: materializationAuthoritySchema,
    amendsEventId: interactionEventIdSchema.optional(),
    status: z.enum(['active', 'redacted']),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.amendsEventId === value.eventId) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['amendsEventId'],
        message: 'an interaction event cannot amend itself',
      });
    }
    if (value.status === 'redacted' && (value.sourceRefs.length !== 0 || value.typedProvenance !== undefined)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['sourceRefs'],
        message: 'redacted events must purge source refs',
      });
    }
    if (value.status === 'active' && value.sourceRefs.length === 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['sourceRefs'],
        message: 'active events require provenance',
      });
    }
  });

export const candidateClaimDraftSchema = z
  .object({
    draftId: candidateClaimDraftIdSchema,
    payload: materializableClaimPayloadSchema,
    normalizedDraft: boundedString(800),
    sourceRole: z.enum(['owner_explicit', 'quoted_third_party']),
    evidenceExcerpt: boundedString(240),
    decision: z.enum(['pending', 'approved', 'rejected']),
  })
  .strict();

export const personIdentityDraftSchema = z
  .object({
    displayName: boundedString(160),
    privateAliases: z.array(boundedString(160)).min(1).max(20),
    workspaceEntityLink: workspaceEntityLinkSchema.optional(),
  })
  .strict();

const candidateDraftEnvelopeShape = {
  draftId: candidateClaimDraftIdSchema,
  normalizedDraft: boundedString(800),
  sourceRole: z.enum(['owner_explicit', 'quoted_third_party']),
  evidenceExcerpt: boundedString(240),
  decision: z.enum(['pending', 'approved', 'rejected']),
};

const interactionPayloadSchema = z
  .object({
    occurredAt: temporalValueSchema.optional(),
    duration: temporalValueSchema.optional(),
    eventKind: z.enum(['conversation', 'meeting', 'message', 'milestone', 'other']),
    headline: boundedString(240),
    importanceOrTopic: boundedString(400),
    uncertaintyNotes: z.array(boundedString(240)).max(4),
  })
  .strict();

const interactionSourceInputSchema = z
  .object({
    messageId: boundedString(240),
    evidenceExcerpt: boundedString(240),
    supports: z.array(personMemoryInteractionEvidenceFieldSchema).min(1).max(6),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (new Set(value.supports).size !== value.supports.length) {
      addCandidateIssue(ctx, ['supports'], 'interaction evidence supports must be unique');
    }
  });

export const interactionSourceEvidenceSchema = z
  .object({
    sourceRef: personMemorySourceRefSchema,
    evidenceExcerpt: boundedString(240),
    supports: z.array(personMemoryInteractionEvidenceFieldSchema).min(1).max(6),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (new Set(value.supports).size !== value.supports.length) {
      addCandidateIssue(ctx, ['supports'], 'interaction evidence supports must be unique');
    }
  });

type InteractionPayload = z.infer<typeof interactionPayloadSchema>;

function requiredInteractionEvidenceFields(payload: InteractionPayload): string[] {
  return [
    'eventKind',
    'headline',
    'importanceOrTopic',
    ...(payload.occurredAt ? ['occurredAt'] : []),
    ...(payload.duration ? ['duration'] : []),
    ...(payload.uncertaintyNotes.length > 0 ? ['uncertaintyNotes'] : []),
  ];
}

function validateInteractionEvidenceCoverage(
  payload: InteractionPayload,
  sources: Array<{ messageId?: string; sourceRef?: PersonMemorySourceRef; supports: string[] }>,
  ctx: z.RefinementCtx,
): void {
  const sourceIds = sources.map((source) => source.messageId ?? source.sourceRef?.messageId);
  if (new Set(sourceIds).size !== sourceIds.length) {
    addCandidateIssue(ctx, ['sources'], 'interaction evidence message IDs must be unique and ordered');
  }
  const supported = new Set(sources.flatMap((source) => source.supports));
  for (const field of requiredInteractionEvidenceFields(payload)) {
    if (!supported.has(field)) {
      addCandidateIssue(ctx, ['sources'], `interaction field ${field} requires source evidence`);
    }
  }
}

export const candidateRelationshipDraftSchema = z
  .object({
    ...candidateDraftEnvelopeShape,
    payload: z
      .object({
        status: z.enum(['current', 'former', 'unknown']),
      })
      .strict(),
  })
  .strict();

export const candidateInteractionProposalSchema = z
  .object({
    normalizedDraft: candidateDraftEnvelopeShape.normalizedDraft,
    sourceRole: candidateDraftEnvelopeShape.sourceRole,
    evidenceExcerpt: candidateDraftEnvelopeShape.evidenceExcerpt,
    payload: interactionPayloadSchema,
    sources: z.array(interactionSourceInputSchema).max(8).default([]),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.sources.length > 0) validateInteractionEvidenceCoverage(value.payload, value.sources, ctx);
  });

export const candidateInteractionDraftSchema = z
  .object({
    ...candidateDraftEnvelopeShape,
    payload: interactionPayloadSchema,
    sourceEvidence: z.array(interactionSourceEvidenceSchema).max(8),
  })
  .strict();

export const personMemoryInteractionApprovalDetailSchema = z
  .object({
    ...interactionPayloadSchema.shape,
    sourceEvidence: z.array(interactionSourceEvidenceSchema).min(1).max(8),
  })
  .strict()
  .superRefine((value, ctx) => {
    validateInteractionEvidenceCoverage(value, value.sourceEvidence, ctx);
  });

const candidateApprovalSchema = z
  .object({
    approvedDraftIds: z.array(candidateClaimDraftIdSchema).min(1).max(PERSON_MEMORY_LIMITS.maxClaimsPerCandidate),
    authorizedAt: timestampSchema,
  })
  .strict();

const captureCandidateBaseSchema = z
  .object({
    candidateId: captureCandidateIdSchema,
    ownerUserId: ownerUserIdSchema,
    requesterCatId: requesterCatIdSchema,
    sourceMessageRef: personMemorySourceRefSchema,
    personDraft: personIdentityDraftSchema.optional(),
    targetPersonId: personIdSchema.optional(),
    claimDrafts: z.array(candidateClaimDraftSchema).max(PERSON_MEMORY_LIMITS.maxClaimsPerCandidate),
    relationshipDraft: candidateRelationshipDraftSchema.optional(),
    interactionDraft: candidateInteractionDraftSchema.optional(),
    sourceBundle: personMemoryResolvedSourceBundleSchema.optional(),
    deferredReceiptId: deferredPersonMemoryReceiptIdSchema.optional(),
    /** IDs-only Standing Reflex lineage; safe to retain after candidate payload purge. */
    writeOpportunityLineage: writeOpportunityLineageV1Schema.optional(),
    replacesProposalId: captureCandidateIdSchema.optional(),
    replacedByProposalId: captureCandidateIdSchema.optional(),
    state: z.enum(PERSON_MEMORY_CANDIDATE_STATES),
    presentedAt: timestampSchema,
    notNowAt: timestampSchema.optional(),
    remainingDraftIds: z.array(candidateClaimDraftIdSchema).max(PERSON_MEMORY_LIMITS.maxClaimsPerCandidate),
    retention: z.literal('owner_controlled_no_ttl'),
    approval: candidateApprovalSchema.optional(),
    createdAt: timestampSchema,
  })
  .strict();

type CaptureCandidateShape = z.infer<typeof captureCandidateBaseSchema>;

const NON_TERMINAL_CANDIDATE_STATES: ReadonlySet<CaptureCandidateShape['state']> = new Set([
  'pending_approval',
  'not_now',
  'partially_materialized',
]);

function addCandidateIssue(ctx: z.RefinementCtx, path: (string | number)[], message: string): void {
  ctx.addIssue({ code: z.ZodIssueCode.custom, path, message });
}

function validateCandidateDraftMembership(value: CaptureCandidateShape, ctx: z.RefinementCtx): Set<string> {
  const draftIds = [
    ...value.claimDrafts.map((draft) => draft.draftId),
    ...(value.relationshipDraft ? [value.relationshipDraft.draftId] : []),
    ...(value.interactionDraft ? [value.interactionDraft.draftId] : []),
  ];
  if (draftIds.length > PERSON_MEMORY_LIMITS.maxClaimsPerCandidate) {
    addCandidateIssue(ctx, ['claimDrafts'], 'a candidate may present at most three exact-bind drafts');
  }
  if (new Set(draftIds).size !== draftIds.length) {
    addCandidateIssue(ctx, ['claimDrafts'], 'draft IDs must be unique');
  }

  const knownDraftIds = new Set<string>(draftIds);
  for (const draftId of value.remainingDraftIds) {
    if (!knownDraftIds.has(draftId)) {
      addCandidateIssue(ctx, ['remainingDraftIds'], 'remaining draft IDs must belong to this candidate');
    }
  }
  if (new Set(value.remainingDraftIds).size !== value.remainingDraftIds.length) {
    addCandidateIssue(ctx, ['remainingDraftIds'], 'remaining draft IDs must be unique');
  }
  return knownDraftIds;
}

function validateCandidateLifecycle(value: CaptureCandidateShape, ctx: z.RefinementCtx): void {
  const nonTerminal = NON_TERMINAL_CANDIDATE_STATES.has(value.state);
  const payloadDraftCount =
    value.claimDrafts.length + (value.relationshipDraft ? 1 : 0) + (value.interactionDraft ? 1 : 0);
  const missingNonTerminalPayload = [
    payloadDraftCount === 0,
    value.remainingDraftIds.length === 0,
    !value.personDraft,
  ].some(Boolean);
  const retainedTerminalPayload = [
    payloadDraftCount > 0,
    value.remainingDraftIds.length > 0,
    value.personDraft !== undefined,
    value.sourceBundle !== undefined,
  ].some(Boolean);
  if (nonTerminal && missingNonTerminalPayload) {
    addCandidateIssue(ctx, ['claimDrafts'], 'non-terminal candidates must retain at least one pending draft');
  }
  if (!nonTerminal && retainedTerminalPayload) {
    addCandidateIssue(ctx, ['claimDrafts'], 'terminal candidates must purge draft and excerpt payload');
  }
  if (value.state === 'not_now' && value.notNowAt === undefined) {
    addCandidateIssue(ctx, ['notNowAt'], 'not-now candidates require notNowAt');
  }
  if (value.state === 'partially_materialized' && value.approval === undefined) {
    addCandidateIssue(ctx, ['approval'], 'partially materialized candidates require approval evidence');
  }
  if (value.replacesProposalId === value.candidateId || value.replacedByProposalId === value.candidateId) {
    addCandidateIssue(ctx, ['replacesProposalId'], 'a candidate cannot replace itself');
  }
  if (value.replacedByProposalId !== undefined && value.state !== 'withdrawn') {
    addCandidateIssue(ctx, ['replacedByProposalId'], 'only withdrawn candidates may point to a replacement');
  }
}

function validateCandidateApproval(
  value: CaptureCandidateShape,
  knownDraftIds: Set<string>,
  ctx: z.RefinementCtx,
): void {
  if (!value.approval) return;
  const approvedIds = new Set<string>(value.approval.approvedDraftIds);
  if (knownDraftIds.size > 0) {
    for (const approvedId of approvedIds) {
      if (!knownDraftIds.has(approvedId)) {
        addCandidateIssue(ctx, ['approval', 'approvedDraftIds'], 'approved draft IDs must belong to this candidate');
      }
    }
  }
  if (value.remainingDraftIds.some((draftId) => approvedIds.has(draftId))) {
    addCandidateIssue(ctx, ['remainingDraftIds'], 'approved drafts cannot remain pending');
  }
}

type ResolvedCandidateBinding = NonNullable<CaptureCandidateShape['sourceBundle']>['assertionBindings'][number];

function claimBindingMatchesPayload(
  role: ResolvedCandidateBinding['role'],
  claim: CandidateClaimDraft | undefined,
): boolean {
  if (role === 'reported_fact') return claim?.payload.kind === 'reported_fact';
  if (role === 'user_assessment') return claim?.payload.kind === 'user_assessment';
  return true;
}

function interactionBindingExceedsRoleCeiling(
  role: ResolvedCandidateBinding['role'],
  assessmentField: boolean,
): boolean {
  if (role === 'reported_fact') return assessmentField;
  if (role === 'user_assessment' || role === 'quoted_third_party') return !assessmentField;
  return false;
}

function validateResolvedCandidateBinding(
  binding: ResolvedCandidateBinding,
  path: readonly (string | number)[],
  claims: Map<string, CandidateClaimDraft>,
  sourceKinds: Map<string, string>,
  ctx: z.RefinementCtx,
): void {
  if (binding.target.kind === 'claim') {
    const claim = claims.get(binding.target.draftId);
    if (!claimBindingMatchesPayload(binding.role, claim)) {
      addCandidateIssue(ctx, [...path, 'role'], 'claim assertion role must match the claim payload');
    }
    return;
  }
  if (binding.target.kind === 'relationship') {
    if (binding.role !== 'reported_fact') {
      addCandidateIssue(ctx, [...path, 'role'], 'relationship status requires reported_fact evidence');
    }
    return;
  }
  const assessmentField = binding.target.field === 'importanceOrTopic' || binding.target.field === 'uncertaintyNotes';
  if (interactionBindingExceedsRoleCeiling(binding.role, assessmentField)) {
    addCandidateIssue(ctx, [...path, 'role'], 'interaction assertion role exceeds its field ceiling');
  }
  if (!assessmentField && sourceKinds.get(binding.sourceId) !== 'message_text') {
    addCandidateIssue(ctx, [...path, 'sourceId'], 'interaction fact fields require direct owner message_text evidence');
  }
}

function validateResolvedCandidateAssertionMatrix(value: CaptureCandidateShape, ctx: z.RefinementCtx): void {
  if (!value.sourceBundle) return;
  const claims = new Map(value.claimDrafts.map((draft) => [draft.draftId, draft]));
  const sourceKinds = new Map(value.sourceBundle.sources.map((source) => [source.sourceId, source.kind]));
  for (const [index, binding] of value.sourceBundle.assertionBindings.entries()) {
    validateResolvedCandidateBinding(binding, ['sourceBundle', 'assertionBindings', index], claims, sourceKinds, ctx);
  }
  if (value.interactionDraft) {
    for (const field of requiredInteractionEvidenceFields(value.interactionDraft.payload)) {
      const covered = value.sourceBundle.assertionBindings.some(
        (binding) =>
          binding.target.kind === 'interaction' &&
          binding.target.draftId === value.interactionDraft?.draftId &&
          binding.target.field === field,
      );
      if (!covered) {
        addCandidateIssue(
          ctx,
          ['sourceBundle', 'assertionBindings'],
          `interaction field ${field} requires typed assertion evidence`,
        );
      }
    }
  }
}

export const captureCandidateSchema = captureCandidateBaseSchema.superRefine((value, ctx) => {
  const knownDraftIds = validateCandidateDraftMembership(value, ctx);
  validateCandidateLifecycle(value, ctx);
  validateCandidateApproval(value, knownDraftIds, ctx);
  validateResolvedCandidateAssertionMatrix(value, ctx);
  if (value.sourceBundle) {
    const boundDraftIds = new Set<string>();
    for (const [index, binding] of value.sourceBundle.assertionBindings.entries()) {
      if (!knownDraftIds.has(binding.target.draftId)) {
        addCandidateIssue(
          ctx,
          ['sourceBundle', 'assertionBindings', index, 'target', 'draftId'],
          'resolved assertion target must belong to this candidate',
        );
      } else {
        boundDraftIds.add(binding.target.draftId);
      }
    }
    for (const draftId of knownDraftIds) {
      if (!boundDraftIds.has(draftId)) {
        addCandidateIssue(ctx, ['sourceBundle'], `draft ${draftId} requires typed assertion evidence`);
      }
    }
  }
  if (value.interactionDraft) {
    if (value.interactionDraft.sourceEvidence.length > 0) {
      validateInteractionEvidenceCoverage(value.interactionDraft.payload, value.interactionDraft.sourceEvidence, ctx);
    }
  }
});

const relationshipCardFactSchema = z
  .object({
    claimId: personClaimIdSchema,
    text: boundedString(320),
    kind: z.enum(['reported_fact', 'user_assessment']),
    provenanceRefs: z.array(personMemorySourceRefSchema).min(1).max(PERSON_MEMORY_LIMITS.maxProvenanceRefsPerCard),
  })
  .strict();

const relationshipCardInteractionSchema = z
  .object({
    eventId: interactionEventIdSchema,
    occurredAt: temporalValueSchema.optional(),
    headline: boundedString(240),
  })
  .strict();

export const relationshipCardSchema = z
  .object({
    personId: personIdSchema,
    relationshipId: personRelationshipIdSchema,
    displayName: boundedString(160),
    facts: z.array(relationshipCardFactSchema).max(PERSON_MEMORY_LIMITS.maxFactsPerRelationshipCard),
    relationshipLine: boundedString(240).optional(),
    latestInteraction: relationshipCardInteractionSchema.optional(),
    uncertainty: z.array(z.enum(['ambiguous', 'stale', 'redacted-source'])).max(3),
    provenanceRefs: z.array(personMemorySourceRefSchema).max(PERSON_MEMORY_LIMITS.maxProvenanceRefsPerCard),
    dossierRef: personIdSchema,
    estimatedTokens: z.number().int().nonnegative().max(PERSON_MEMORY_LIMITS.maxRelationshipCardTokens),
    storable: z.literal(false),
    indexable: z.literal(false),
  })
  .strict();

export const personMemoryApprovalProjectionSchema = z
  .object({
    candidateId: captureCandidateIdSchema,
    envelopeRef: boundedString(320),
    chatCardMessageId: boundedString(240),
    decisionSurface: z.literal('approval_hub'),
  })
  .strict();

export const personMemoryDeletionReceiptSchema = z
  .object({
    requestId: personForgetRequestIdSchema,
    ownerUserId: ownerUserIdSchema,
    completedAt: timestampSchema,
    purgedSurfaceCounts: z.record(z.string().min(1).max(80), z.number().int().nonnegative()),
    verdict: z.enum(['purged', 'already_absent']),
  })
  .strict();

export const personMemorySuppressionTokenSchema = z
  .object({
    tokenId: personSuppressionTokenIdSchema,
    ownerUserId: ownerUserIdSchema,
    candidateId: captureCandidateIdSchema,
    subjectRefs: z.array(boundedString(160)).min(1).max(21),
    createdAt: timestampSchema,
  })
  .strict()
  .superRefine((value, ctx) => {
    if (new Set(value.subjectRefs).size !== value.subjectRefs.length) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['subjectRefs'],
        message: 'suppression subject refs must be unique',
      });
    }
  });

export type JsonValue = z.infer<typeof jsonValueSchema>;
export type TemporalValue = z.infer<typeof temporalValueSchema>;
export type MaterializableClaimPayload = z.infer<typeof materializableClaimPayloadSchema>;
export type MaterializationAuthority = z.infer<typeof materializationAuthoritySchema>;
export type WorkspaceEntityLink = z.infer<typeof workspaceEntityLinkSchema>;
export type PersonIdentity = z.infer<typeof personIdentitySchema>;
export type PersonClaimVersion = z.infer<typeof personClaimVersionSchema>;
export type PersonRelationship = z.infer<typeof personRelationshipSchema>;
export type PersonRelationshipTransition = z.infer<typeof personRelationshipTransitionSchema>;
export type InteractionEvent = z.infer<typeof interactionEventSchema>;
export type CandidateClaimDraft = z.infer<typeof candidateClaimDraftSchema>;
export type CandidateRelationshipDraft = z.infer<typeof candidateRelationshipDraftSchema>;
export type CandidateInteractionDraft = z.infer<typeof candidateInteractionDraftSchema>;
export type CandidateInteractionProposal = z.infer<typeof candidateInteractionProposalSchema>;
export type PersonMemoryInteractionApprovalDetail = z.infer<typeof personMemoryInteractionApprovalDetailSchema>;
export type PersonIdentityDraft = z.infer<typeof personIdentityDraftSchema>;
export type CaptureCandidateState = (typeof PERSON_MEMORY_CANDIDATE_STATES)[number];
export type CaptureCandidate = z.infer<typeof captureCandidateSchema>;
export type RelationshipCard = z.infer<typeof relationshipCardSchema>;
export type PersonMemoryApprovalProjection = z.infer<typeof personMemoryApprovalProjectionSchema>;
export type PersonMemoryDeletionReceipt = z.infer<typeof personMemoryDeletionReceiptSchema>;
export type PersonMemorySuppressionToken = z.infer<typeof personMemorySuppressionTokenSchema>;
