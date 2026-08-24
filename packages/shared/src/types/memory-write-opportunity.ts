import { z } from 'zod';
import {
  type DeferredWriteOpportunityReceiptV1,
  deferredPersonMemoryReceiptIdSchema,
  deferredWriteOpportunityReceiptV1Schema,
  deferredWriteOpportunitySourceRefV1Schema,
} from './proactive-memory-deferred-receipt.js';
import { proactiveMemoryAbstentionReasonCodeSchema } from './proactive-memory-opportunity.js';

const bounded = (max: number) => z.string().trim().min(1).max(max);
const timestampSchema = z.number().int().nonnegative().finite();
const sha256RevisionSchema = z.string().regex(/^sha256:[a-f0-9]{64}$/);
const writeOpportunityLineageSchema = z.string().regex(/^write_lineage_[a-f0-9]{32}$/);
export const MAX_WRITE_OPPORTUNITY_GENERATION = 0xffff_ffff;

/** Stable, portable generation ID: 96 lineage bits + the bounded 32-bit generation. */
export function writeOpportunityGenerationId(dedupeLineage: string, generation: number): string {
  const lineage = writeOpportunityLineageSchema.parse(dedupeLineage).slice('write_lineage_'.length);
  if (!Number.isInteger(generation) || generation < 1 || generation > MAX_WRITE_OPPORTUNITY_GENERATION) {
    throw new RangeError('write opportunity generation must be a positive uint32');
  }
  return `write_opp_${lineage.slice(0, 24)}${generation.toString(16).padStart(8, '0')}`;
}

export const WRITE_OPPORTUNITY_DISPOSITIONS = ['propose', 'defer', 'abstain'] as const;
export const WRITE_OPPORTUNITY_INVALIDATORS = [
  'source_corrected',
  'source_forgotten',
  'scope_revoked',
  'superseded',
  'expired',
] as const;

export const asrTranscriptSourceCoordinateV1Schema = z
  .object({
    kind: z.literal('asr_transcript_segment'),
    artifactId: bounded(240),
    sourceHandle: bounded(1_000),
    sourceRevision: sha256RevisionSchema,
    segment: z
      .object({
        unit: z.literal('utf8_byte'),
        start: z.number().int().nonnegative(),
        end: z.number().int().positive(),
      })
      .strict(),
    speaker: z
      .object({
        externalSpeakerId: bounded(160),
        label: bounded(160),
        attributionRevision: sha256RevisionSchema,
        attributionCeiling: z.enum(['unattributed', 'machine_diarized', 'owner_confirmed_mapping']),
      })
      .strict(),
  })
  .strict()
  .refine((value) => value.segment.end > value.segment.start, {
    path: ['segment', 'end'],
    message: 'segment end must be greater than start',
  });

export const asrPersonMemoryWriteOpportunityV1Schema = z
  .object({
    v: z.literal(1),
    opportunityId: z.string().regex(/^write_opp_[a-f0-9]{32}$/),
    reflexId: z.literal('asr-person-memory'),
    reflexVersion: z.literal(1),
    generation: z.number().int().positive().max(MAX_WRITE_OPPORTUNITY_GENERATION),
    producer: z.literal('meeting_artifact'),
    consumer: z
      .object({
        kind: z.literal('cat'),
        catId: bounded(160),
      })
      .strict(),
    scope: z
      .object({
        ownerUserId: bounded(160),
        threadId: bounded(160),
      })
      .strict(),
    observedAt: timestampSchema,
    eligibleAt: timestampSchema,
    expiresAt: timestampSchema,
    sourceCoordinates: z.array(asrTranscriptSourceCoordinateV1Schema).min(1).max(8),
    epistemicCeiling: z.literal('mechanical_observation'),
    destination: z
      .object({
        lane: z.literal('person_memory'),
        proposalContract: z.literal('F276.CaptureCandidate.v1'),
      })
      .strict(),
    dedupeLineage: writeOpportunityLineageSchema,
    rearmPredicate: z.literal('next_eligible_owner_context_after_defer'),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.eligibleAt < value.observedAt) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['eligibleAt'], message: 'eligibleAt precedes observation' });
    }
    if (value.expiresAt <= value.eligibleAt) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['expiresAt'], message: 'expiry must follow eligibility' });
    }
    const revisions = new Set(value.sourceCoordinates.map((coordinate) => coordinate.sourceRevision));
    if (revisions.size !== 1) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['sourceCoordinates'],
        message: 'one opportunity generation must bind one source revision',
      });
    }
  });

export const asrPersonMemoryDynamicSceneEntryV1Schema = z
  .object({
    v: z.literal(1),
    kind: z.literal('memory_write_opportunity'),
    surface: z.literal('dynamic_context'),
    opportunity: asrPersonMemoryWriteOpportunityV1Schema,
  })
  .strict();

/** Server-written scheduler carrier for a mechanically re-armed deferred generation. */
export const writeOpportunityReentryCarrierV1Schema = z
  .object({
    v: z.literal(1),
    sourceMessageRef: z
      .object({
        kind: z.literal('message'),
        threadId: bounded(160),
        messageId: bounded(240),
      })
      .strict(),
    sourceOpportunityId: z.string().regex(/^write_opp_[a-f0-9]{32}$/),
    priorGeneration: z
      .number()
      .int()
      .positive()
      .max(MAX_WRITE_OPPORTUNITY_GENERATION - 1),
    scene: asrPersonMemoryDynamicSceneEntryV1Schema,
  })
  .strict();

/** Server-written, refs-only carrier for re-presenting one unchanged opportunity generation. */
export const writeOpportunityPresentationRetryCarrierV1Schema = z
  .object({
    v: z.literal(1),
    sourceMessageRef: z
      .object({
        kind: z.literal('message'),
        threadId: bounded(160),
        messageId: bounded(240),
      })
      .strict(),
    sourceOpportunityId: z.string().regex(/^write_opp_[a-f0-9]{32}$/),
  })
  .strict();

const dispositionBase = {
  v: z.literal(1),
  opportunityId: z.string().regex(/^write_opp_[a-f0-9]{32}$/),
  generation: z.number().int().positive().max(MAX_WRITE_OPPORTUNITY_GENERATION),
  recordedAt: timestampSchema,
};

const proposedDispositionSchema = z
  .object({
    ...dispositionBase,
    disposition: z.literal('propose'),
    destination: z
      .object({
        proposalContract: z.literal('F276.CaptureCandidate.v1'),
        proposalId: bounded(240),
      })
      .strict(),
  })
  .strict();

const deferredDispositionSchema = z
  .object({
    ...dispositionBase,
    disposition: z.literal('defer'),
    destination: z
      .object({
        receiptContract: z.literal('StandingReflex.DeferredWriteOpportunityReceipt.v1'),
        receiptId: deferredPersonMemoryReceiptIdSchema,
      })
      .strict(),
  })
  .strict();

const abstainedDispositionSchema = z
  .object({
    ...dispositionBase,
    disposition: z.literal('abstain'),
    reasonCode: proactiveMemoryAbstentionReasonCodeSchema,
  })
  .strict();

export const writeOpportunityDispositionV1Schema = z.discriminatedUnion('disposition', [
  proposedDispositionSchema,
  deferredDispositionSchema,
  abstainedDispositionSchema,
]);

/**
 * Wave 2 bridge: what `recordPresentation` must persist so a later F276 tool callback can be bound
 * back to the opportunity that prompted it. The disposition arrives on a separate HTTP callback with
 * no access to the invocation closure, so these facts have to outlive it.
 *
 * Content-free by construction, not by convention: `sourceRefs` reuses `deferredSourceRefV1Schema`,
 * which has no field for a speaker label, source handle, or transcript text. There is nowhere to put
 * payload even by mistake (F296:268, F276 AC-A20).
 */
export const deliveredWriteOpportunityRecordV1Schema = z
  .object({
    v: z.literal(1),
    opportunityId: z.string().regex(/^write_opp_[a-f0-9]{32}$/),
    dedupeLineage: writeOpportunityLineageSchema,
    generation: z.number().int().positive().max(MAX_WRITE_OPPORTUNITY_GENERATION),
    reflexId: z.literal('asr-person-memory'),
    reflexVersion: z.literal(1),
    ownerUserId: bounded(160),
    threadId: bounded(160),
    consumerCatId: bounded(160),
    invocationId: bounded(240),
    eligibleAt: timestampSchema,
    expiresAt: timestampSchema,
    rearmPredicate: z.literal('next_eligible_owner_context_after_defer'),
    destinationProposalContract: z.literal('F276.CaptureCandidate.v1'),
    sourceRefs: z.array(deferredWriteOpportunitySourceRefV1Schema).min(1).max(8),
    presentedAt: timestampSchema,
    generationId: sha256RevisionSchema,
    evidenceRef: bounded(500),
    continuityDispositionRef: bounded(500),
  })
  .strict()
  .refine((value) => value.expiresAt > value.eligibleAt, {
    path: ['expiresAt'],
    message: 'expiry must follow eligibility',
  });

export type DeliveredWriteOpportunityRecordV1 = z.infer<typeof deliveredWriteOpportunityRecordV1Schema>;

/** Narrow a delivered opportunity to the content-free facts a later disposition needs. */
export function projectDeliveredWriteOpportunityRecord(
  opportunity: AsrPersonMemoryWriteOpportunityV1,
  evidence: {
    readonly ownerUserId: string;
    readonly threadId: string;
    readonly consumerCatId: string;
    readonly invocationId: string;
    readonly presentedAt: number;
    readonly generationId: string;
    readonly evidenceRef: string;
    readonly continuityDispositionRef: string;
  },
): DeliveredWriteOpportunityRecordV1 {
  return deliveredWriteOpportunityRecordV1Schema.parse({
    v: 1,
    opportunityId: opportunity.opportunityId,
    dedupeLineage: opportunity.dedupeLineage,
    generation: opportunity.generation,
    reflexId: opportunity.reflexId,
    reflexVersion: opportunity.reflexVersion,
    ownerUserId: evidence.ownerUserId,
    threadId: evidence.threadId,
    consumerCatId: evidence.consumerCatId,
    invocationId: evidence.invocationId,
    eligibleAt: opportunity.eligibleAt,
    expiresAt: opportunity.expiresAt,
    rearmPredicate: opportunity.rearmPredicate,
    destinationProposalContract: opportunity.destination.proposalContract,
    sourceRefs: opportunity.sourceCoordinates.map((coordinate) => ({
      artifactId: coordinate.artifactId,
      sourceRevision: coordinate.sourceRevision,
      attributionRevision: coordinate.speaker.attributionRevision,
      segmentStart: coordinate.segment.start,
      segmentEnd: coordinate.segment.end,
    })),
    presentedAt: evidence.presentedAt,
    generationId: evidence.generationId,
    evidenceRef: evidence.evidenceRef,
    continuityDispositionRef: evidence.continuityDispositionRef,
  });
}

export const ASR_PERSON_MEMORY_REFLEX_ENTRY_V1 = Object.freeze({
  v: 1 as const,
  reflexId: 'asr-person-memory' as const,
  version: 1 as const,
  ownerCell: 'memory/private-person-relationship' as const,
  consumer: 'agent_route' as const,
  eligibleDestinationLanes: ['person_memory'] as const,
  producer: 'meeting_artifact' as const,
  predicateRef: 'confirmed-meeting-speaker-map-present' as const,
  predicateRevision: 1 as const,
  sourceCoordinateKinds: ['asr_transcript_segment'] as const,
  epistemicCeiling: 'mechanical_observation' as const,
  allowedDispositions: WRITE_OPPORTUNITY_DISPOSITIONS,
  immediateTargetByLane: { person_memory: 'F276.CaptureCandidate.v1' as const },
  deferredTargetByLane: { person_memory: 'F276.CaptureCandidate.v1' as const },
  deferredReceiptContract: 'StandingReflex.DeferredWriteOpportunityReceipt.v1' as const,
  eligibleSurfaces: ['dynamic_context'] as const,
  presentationPolicyRef: 'F296.OpportunityPresentation' as const,
  tokenBudget: 160,
  expiryMs: 7 * 24 * 60 * 60 * 1_000,
  rearmPredicate: 'next_eligible_owner_context_after_defer' as const,
  invalidators: WRITE_OPPORTUNITY_INVALIDATORS,
  sunsetOwner: 'memory/private-person-relationship' as const,
});

export type AsrTranscriptSourceCoordinateV1 = z.infer<typeof asrTranscriptSourceCoordinateV1Schema>;
export type AsrPersonMemoryWriteOpportunityV1 = z.infer<typeof asrPersonMemoryWriteOpportunityV1Schema>;
export type AsrPersonMemoryDynamicSceneEntryV1 = z.infer<typeof asrPersonMemoryDynamicSceneEntryV1Schema>;
export type WriteOpportunityReentryCarrierV1 = z.infer<typeof writeOpportunityReentryCarrierV1Schema>;
export type WriteOpportunityPresentationRetryCarrierV1 = z.infer<
  typeof writeOpportunityPresentationRetryCarrierV1Schema
>;
export type WriteOpportunityDispositionV1 = z.infer<typeof writeOpportunityDispositionV1Schema>;
export { deferredWriteOpportunityReceiptV1Schema, type DeferredWriteOpportunityReceiptV1 };
