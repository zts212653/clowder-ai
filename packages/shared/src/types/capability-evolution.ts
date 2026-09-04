// biome-ignore-all format: Compact state-machine contract stays below the repository's 350-line hard limit.
import { z } from 'zod';
import {
  attributionLinkedEventV1Schema,
  measurementLinkedEventV1Schema,
  observeOrInsufficientEventV1Schema,
} from './capability-evolution-diagnosis.js';
import { evolutionObservationSetupV1Schema } from './capability-evolution-observation.js';
import { assetOwnerIdentity, assetVersionRefV1Schema, bounded, exactAssetVersionRefV1Schema, ownerTruthRefV1Schema, strictEvent, timestampSchema } from './capability-evolution-refs.js';

export * from './capability-evolution-diagnosis.js';
export * from './capability-evolution-refs.js';

const certificatesSchema = z
  .object({
    goal: ownerTruthRefV1Schema.optional(),
    measurement: ownerTruthRefV1Schema.optional(),
    economic: ownerTruthRefV1Schema.optional(),
  })
  .strict();
const completeCertificatesSchema = z.object({
  goal: ownerTruthRefV1Schema,
  measurement: ownerTruthRefV1Schema,
  economic: ownerTruthRefV1Schema,
}).strict();
const measurementRoleRefsSchema = z
  .object({
    observer: ownerTruthRefV1Schema.optional(),
    domainOwner: ownerTruthRefV1Schema.optional(),
    consumer: ownerTruthRefV1Schema.optional(),
    calibrator: ownerTruthRefV1Schema.optional(),
    overlapJustification: bounded(1_000).optional(),
  })
  .strict();
const completeMeasurementRoleRefsSchema = z.object({
  observer: ownerTruthRefV1Schema,
  domainOwner: ownerTruthRefV1Schema,
  consumer: ownerTruthRefV1Schema,
  calibrator: ownerTruthRefV1Schema,
  overlapJustification: bounded(1_000).optional(),
}).strict();
const retentionSchema = z.discriminatedUnion('mode', [
  z.object({ mode: z.literal('keep_forever'), optedInBy: bounded(240), optedInAt: timestampSchema }).strict(),
  z
    .object({
      mode: z.literal('forget_after'),
      optedInBy: bounded(240),
      optedInAt: timestampSchema,
      ttlSeconds: z.number().int().positive(),
    })
    .strict(),
]);

const interventionReceiptLinkedEventV1Schema = strictEvent({
  type: z.literal('intervention_receipt_linked'),
  result: z.enum(['changed', 'no_change']),
  interventionReceiptRef: ownerTruthRefV1Schema,
  assetVersionRef: exactAssetVersionRefV1Schema,
  loadedRuntimeRef: ownerTruthRefV1Schema.optional(),
});

export const EVOLUTION_PROGRAM_LIFECYCLES = ['active', 'paused', 'needs_expert', 'terminal'] as const;
// biome-ignore format: Dense canonical order mirrors the lifecycle table.
export const EVOLUTION_PROGRAM_STAGES = [
  'constituting', 'instrumenting', 'observing', 'evaluating', 'attributing', 'awaiting_intervention',
  'awaiting_approval', 'writing_back', 'revalidating', 'deciding',
] as const;
// The plan freezes `insufficient`; Phase 1 measurement events route it back to observing without closing the Cycle.
export const EVOLUTION_CYCLE_DECISIONS = ['keep', 'tune', 'rollback', 'sunset', 'no_change', 'insufficient'] as const;

export const evolutionProgramV1Schema = z
  .object({
    schemaVersion: z.literal(1),
    programId: bounded(240),
    workspaceId: bounded(240),
    objectRef: ownerTruthRefV1Schema,
    claimRef: ownerTruthRefV1Schema,
    certificates: certificatesSchema,
    valueOwnerRef: ownerTruthRefV1Schema.optional(),
    measurementRoleRefs: measurementRoleRefsSchema,
    lifecycle: z.enum(EVOLUTION_PROGRAM_LIFECYCLES),
    stage: z.enum(EVOLUTION_PROGRAM_STAGES),
    cycle: z.number().int().positive(),
    sequence: z.number().int().nonnegative(),
    currentAssetVersionRefs: z.array(assetVersionRefV1Schema).max(128),
    terminalDisposition: z.enum(['kept', 'sunset', 'no_change', 'withdrawn']).optional(),
    retention: retentionSchema.optional(),
    createdAt: timestampSchema,
    updatedAt: timestampSchema,
  })
  .strict()
  .superRefine((value, ctx) => {
    if ((value.lifecycle === 'terminal') !== (value.terminalDisposition !== undefined)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['terminalDisposition'], message: 'terminal disposition must match lifecycle' });
    }
    if (value.retention !== undefined && value.lifecycle !== 'terminal') {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['retention'], message: 'retention requires a terminal Program' });
    }
    if (value.stage !== 'constituting') {
      const required = [value.valueOwnerRef, value.certificates.goal, value.certificates.measurement, value.certificates.economic,
        value.measurementRoleRefs.observer, value.measurementRoleRefs.domainOwner, value.measurementRoleRefs.consumer, value.measurementRoleRefs.calibrator];
      if (required.includes(undefined)) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['stage'], message: 'ready stages require complete certificates, value owner, and measurement roles' });
      }
    }
    const keys = value.currentAssetVersionRefs.map(assetOwnerIdentity);
    if (new Set(keys).size !== keys.length) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['currentAssetVersionRefs'], message: 'asset identities must be unique' });
    }
  });

export const evolutionCycleV1Schema = z
  .object({
    programId: bounded(240),
    cycle: z.number().int().positive(),
    stage: z.enum(EVOLUTION_PROGRAM_STAGES),
    lineageRefIds: z.array(bounded(1_000)).max(256),
    interventionLayerRef: ownerTruthRefV1Schema.optional(),
    openedAt: timestampSchema,
    closedAt: timestampSchema.optional(),
    decision: z.enum(EVOLUTION_CYCLE_DECISIONS).optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.decision !== undefined && value.closedAt === undefined) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['closedAt'], message: 'a decided Cycle must be closed' });
    }
    if (new Set(value.lineageRefIds).size !== value.lineageRefIds.length) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['lineageRefIds'], message: 'lineage refs must be unique' });
    }
    if (value.stage === 'instrumenting' && value.interventionLayerRef !== undefined)
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['stage'], message: 'an instrumenting Cycle cannot have an intervention layer' });
  });

export const evolutionProgramStateV1Schema = z
  .object({ program: evolutionProgramV1Schema, cycles: z.array(evolutionCycleV1Schema).min(1) })
  .strict()
  .superRefine((value, ctx) => {
    const current = value.cycles.at(-1);
    if (current?.programId !== value.program.programId || current.cycle !== value.program.cycle || current.stage !== value.program.stage) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['cycles'], message: 'current Cycle must match Program projection' });
    }
    const open = value.cycles.filter((cycle) => cycle.closedAt === undefined).length;
    if (open !== (value.program.lifecycle === 'terminal' ? 0 : 1)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['cycles'], message: 'exactly one non-terminal Cycle may be current' });
    }
  });

// biome-ignore format: Keeping the closed event vocabulary together makes payload auditing tractable.
const evolutionProgramEventV1Union = z.discriminatedUnion('type', [
  strictEvent({ type: z.literal('program_created'), workspaceId: bounded(240), objectRef: ownerTruthRefV1Schema, claimRef: ownerTruthRefV1Schema }),
  strictEvent({ type: z.literal('certificates_linked'), certificates: completeCertificatesSchema, valueOwnerRef: ownerTruthRefV1Schema, measurementRoleRefs: completeMeasurementRoleRefsSchema }),
  strictEvent({ type: z.literal('sources_and_triggers_linked'), sourceRefs: z.array(ownerTruthRefV1Schema).min(1).max(128), triggerRef: ownerTruthRefV1Schema, namedConsumerRef: ownerTruthRefV1Schema }),
  strictEvent({ type: z.literal('observation_setup_linked'), setup: evolutionObservationSetupV1Schema }),
  strictEvent({ type: z.literal('evaluation_triggered'), triggerReceiptRef: ownerTruthRefV1Schema, exposureProofRef: ownerTruthRefV1Schema }),
  measurementLinkedEventV1Schema,
  attributionLinkedEventV1Schema,
  strictEvent({ type: z.literal('intervention_linked'), interventionCardRef: ownerTruthRefV1Schema, interventionLayerRef: ownerTruthRefV1Schema, gateReceiptRef: ownerTruthRefV1Schema }),
  observeOrInsufficientEventV1Schema,
  strictEvent({ type: z.literal('change_cycle_linked'), caseRef: ownerTruthRefV1Schema, proposalRef: ownerTruthRefV1Schema, ownerAuthorizationRef: ownerTruthRefV1Schema, targetVersionRef: exactAssetVersionRefV1Schema }),
  strictEvent({ type: z.literal('approval_linked'), approvalRef: ownerTruthRefV1Schema, targetVersionRef: exactAssetVersionRefV1Schema }),
  strictEvent({ type: z.literal('approval_rejected_or_superseded'), result: z.enum(['rejected', 'withdrawn', 'superseded', 'target_drift']), decisionRef: ownerTruthRefV1Schema }),
  interventionReceiptLinkedEventV1Schema,
  strictEvent({ type: z.literal('outcome_linked'), outcomeReceiptRef: ownerTruthRefV1Schema, freshnessProofRef: ownerTruthRefV1Schema }),
  strictEvent({ type: z.literal('decision_recorded'), decision: z.enum(['keep', 'tune', 'rollback', 'sunset', 'no_change']), decisionRef: ownerTruthRefV1Schema, executionReceiptRef: ownerTruthRefV1Schema.optional(), assetVersionRef: exactAssetVersionRefV1Schema.optional() }),
  strictEvent({ type: z.literal('program_paused'), reasonRef: ownerTruthRefV1Schema }),
  strictEvent({ type: z.literal('program_resumed'), resumeRef: ownerTruthRefV1Schema }),
  strictEvent({ type: z.literal('expert_required'), missingRole: z.enum(['observer', 'domain_owner', 'consumer', 'calibrator']), blockerRef: ownerTruthRefV1Schema }),
  strictEvent({ type: z.literal('expert_bound'), roleOwnerRef: ownerTruthRefV1Schema }),
  strictEvent({ type: z.literal('program_withdrawn'), decisionRef: ownerTruthRefV1Schema }),
  strictEvent({ type: z.literal('retention_opted_in'), retention: retentionSchema, retentionActionRef: ownerTruthRefV1Schema }),
]);

function validateInterventionReceipt(
  event: z.infer<typeof interventionReceiptLinkedEventV1Schema>,
  ctx: z.RefinementCtx,
) {
  if (event.result === 'changed' && event.loadedRuntimeRef === undefined) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'changed intervention requires a loaded runtime' });
  }
  if (event.result === 'no_change' && event.loadedRuntimeRef !== undefined) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'no_change intervention forbids a loaded runtime' });
  }
}

function validateDecisionEvent(
  event: Extract<z.infer<typeof evolutionProgramEventV1Union>, { type: 'decision_recorded' }>,
  ctx: z.RefinementCtx,
) {
  if (
    (event.decision === 'rollback' || event.decision === 'no_change') &&
    (event.executionReceiptRef === undefined || event.assetVersionRef === undefined)
  ) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: `${event.decision} requires owner receipt and exact asset version`,
    });
  }
  if (event.decision === 'sunset' && event.executionReceiptRef === undefined) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'sunset requires owner execution receipt' });
  }
  if (event.decision !== 'rollback' && event.decision !== 'no_change' && event.assetVersionRef !== undefined) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'only rollback or no_change may bind an asset version at decision time',
    });
  }
}

export const evolutionProgramEventV1Schema = evolutionProgramEventV1Union.superRefine((event, ctx) => {
  if (event.type === 'intervention_receipt_linked') validateInterventionReceipt(event, ctx);
  if (event.type === 'decision_recorded') validateDecisionEvent(event, ctx);
});

export const evolutionProgramEventEnvelopeV1Schema = z
  .object({
    schemaVersion: z.literal(1), eventId: bounded(240), programId: bounded(240),
    expectedSequence: z.number().int().nonnegative(), clientMessageId: bounded(240), actorRef: bounded(500),
    originRef: bounded(1_000), occurredAt: timestampSchema, event: evolutionProgramEventV1Schema,
    /**
     * Digest of the ORIGINATING request, persisted so a later retry can be told apart from a reused
     * client message id without re-deriving the event — deriving it may need an owner call that is
     * no longer reachable. Optional because events appended before this field existed have none; an
     * absent digest never matches, so those fall through to the append path's full identity check
     * instead of being silently accepted as duplicates.
     */
    commandDigest: bounded(120).optional(),
  })
  .strict();

export type EvolutionProgramLifecycle = (typeof EVOLUTION_PROGRAM_LIFECYCLES)[number];
export type EvolutionProgramStage = (typeof EVOLUTION_PROGRAM_STAGES)[number];
export type EvolutionCycleDecision = (typeof EVOLUTION_CYCLE_DECISIONS)[number];
export type EvolutionProgramV1 = z.infer<typeof evolutionProgramV1Schema>;
export type EvolutionCycleV1 = z.infer<typeof evolutionCycleV1Schema>;
export type EvolutionProgramStateV1 = z.infer<typeof evolutionProgramStateV1Schema>;
export type EvolutionProgramEventV1 = z.infer<typeof evolutionProgramEventV1Schema>;
export type EvolutionProgramEventEnvelopeV1 = z.infer<typeof evolutionProgramEventEnvelopeV1Schema>;

export * from './capability-evolution-reducer.js';