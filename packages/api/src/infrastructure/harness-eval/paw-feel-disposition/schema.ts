import {
  exactAssetVersionRefV1Schema,
  ownerTruthRefV1Schema,
  PAW_FEEL_NO_ACTION_REASONS,
  type PawFeelDispositionEvent,
  pawFeelRepairBindingSchema,
} from '@cat-cafe/shared';
import { z } from 'zod';

const nonEmptyString = z.string().trim().min(1);
const isoDateTime = z.string().datetime({ offset: true });
const sha256Digest = z.string().regex(/^[a-f0-9]{64}$/);

export const PawFeelResumeSelectorV1Schema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('task'), ref: ownerTruthRefV1Schema }).strict(),
  z.object({ kind: z.literal('owner_event'), ref: ownerTruthRefV1Schema }).strict(),
  z
    .object({
      kind: z.literal('bounded_time'),
      recheckAt: isoDateTime,
      dependencyRef: ownerTruthRefV1Schema.optional(),
    })
    .strict(),
]);

export const PawFeelResumeConditionV1Schema = z
  .object({
    schemaVersion: z.literal(1),
    blockedEpisode: ownerTruthRefV1Schema,
    selector: PawFeelResumeSelectorV1Schema,
    conditionId: sha256Digest,
    blockedVersion: sha256Digest,
  })
  .strict();

export const PawFeelDirectRepairBindingV1Schema = z
  .object({
    schemaVersion: z.literal(1),
    bindingRef: ownerTruthRefV1Schema,
    sourceSignalRef: ownerTruthRefV1Schema,
    sourceToolRef: ownerTruthRefV1Schema,
    providerId: nonEmptyString,
    providerVersion: nonEmptyString,
    providerRouteRef: ownerTruthRefV1Schema,
    resolvedActionRef: ownerTruthRefV1Schema,
    actionScopeRef: ownerTruthRefV1Schema,
    ownerAuthorizationRef: ownerTruthRefV1Schema,
    targetVersionRef: exactAssetVersionRefV1Schema,
    ownerCatId: nonEmptyString,
    outcomeVerifierRef: ownerTruthRefV1Schema,
  })
  .strict();

export const PawFeelDirectRepairOutcomeV1Schema = z
  .object({
    schemaVersion: z.literal(1),
    bindingRef: ownerTruthRefV1Schema,
    taskTerminalRef: ownerTruthRefV1Schema,
    leaseTerminalRef: ownerTruthRefV1Schema.optional(),
    ownerOutcomeRef: ownerTruthRefV1Schema,
    verificationRefs: z.tuple([ownerTruthRefV1Schema]).rest(ownerTruthRefV1Schema),
    disposition: z.enum(['verified_changed', 'verified_no_change']),
  })
  .strict();

export const PawFeelDispositionActorSchema = z
  .object({
    kind: z.enum(['cat', 'cvo', 'automation', 'migration']),
    id: nonEmptyString,
  })
  .strict();

export const PawFeelSourceRefSchema = z
  .object({
    sourceMessageId: nonEmptyString,
    sourceThreadId: nonEmptyString,
    sourceCatId: nonEmptyString,
    markerDigest: sha256Digest,
    sameDigestOrdinal: z.number().int().nonnegative(),
    markerIndex: z.number().int().nonnegative(),
  })
  .strict();

const eventBaseSchema = z
  .object({
    eventId: nonEmptyString,
    signalId: nonEmptyString,
    actor: PawFeelDispositionActorSchema,
    occurredAt: isoDateTime,
  })
  .strict();

const signatureActionSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('duplicate'), duplicateOf: nonEmptyString }).strict(),
  z.object({ type: z.literal('no_action'), reasonCode: z.enum(PAW_FEEL_NO_ACTION_REASONS) }).strict(),
  z
    .object({
      type: z.literal('fix'),
      ownerCatId: nonEmptyString,
      taskId: nonEmptyString,
      repairBinding: pawFeelRepairBindingSchema.optional(),
      leaseId: nonEmptyString.optional(),
      leaseGeneration: z.number().int().nonnegative().optional(),
      custodyEvidenceRef: nonEmptyString,
      directRepairBinding: PawFeelDirectRepairBindingV1Schema.optional(),
    })
    .strict(),
]);

export const PawFeelDispositionEventSchema = z.discriminatedUnion('type', [
  eventBaseSchema
    .extend({
      type: z.literal('discovered'),
      source: PawFeelSourceRefSchema,
      backfilled: z.boolean(),
      captureMethod: z.enum(['typed', 'legacy_parser']).default('legacy_parser'),
      captureAssessment: z.enum(['confirmed', 'ambiguous', 'contaminated']).default('ambiguous'),
    })
    .strict(),
  eventBaseSchema.extend({ type: z.literal('seen') }).strict(),
  eventBaseSchema
    .extend({
      type: z.literal('route_pending'),
      targetThreadId: nonEmptyString.optional(),
      ownerEvidenceRef: nonEmptyString.optional(),
      proposalId: nonEmptyString.optional(),
    })
    .strict(),
  eventBaseSchema
    .extend({
      type: z.literal('routed'),
      targetThreadId: nonEmptyString.optional(),
      proposalId: nonEmptyString.optional(),
      receiptRef: nonEmptyString,
    })
    .strict(),
  eventBaseSchema
    .extend({
      type: z.literal('route_reopened'),
      rejectionRef: nonEmptyString,
      reasonCode: nonEmptyString,
    })
    .strict(),
  eventBaseSchema
    .extend({
      type: z.literal('closed'),
      reasonCode: nonEmptyString,
      outcomeRef: nonEmptyString,
    })
    .strict(),
  eventBaseSchema
    .extend({
      type: z.literal('duplicate'),
      duplicateOf: nonEmptyString,
      ownerCatId: nonEmptyString.optional(),
    })
    .strict(),
  eventBaseSchema
    .extend({
      type: z.literal('no_action'),
      reasonCode: z.enum(PAW_FEEL_NO_ACTION_REASONS),
      ownerCatId: nonEmptyString.optional(),
    })
    .strict(),
  eventBaseSchema
    .extend({
      type: z.literal('fix'),
      ownerCatId: nonEmptyString,
      taskId: nonEmptyString,
      repairBinding: pawFeelRepairBindingSchema.optional(),
      leaseId: nonEmptyString.optional(),
      leaseGeneration: z.number().int().nonnegative().optional(),
      custodyEvidenceRef: nonEmptyString,
      directRepairBinding: PawFeelDirectRepairBindingV1Schema.optional(),
    })
    .strict(),
  eventBaseSchema
    .extend({
      type: z.literal('signature_requested'),
      action: signatureActionSchema,
      preferredSignerCatId: nonEmptyString.optional(),
    })
    .strict(),
  eventBaseSchema
    .extend({
      type: z.literal('blocked'),
      blockerCode: nonEmptyString,
      blockerRef: nonEmptyString,
      resumeCondition: PawFeelResumeConditionV1Schema.optional(),
    })
    .strict(),
  eventBaseSchema
    .extend({
      type: z.literal('blocker_reopened'),
      reopen: z.discriminatedUnion('kind', [
        z
          .object({
            kind: z.literal('condition'),
            conditionId: sha256Digest,
            blockedVersion: sha256Digest,
            resumeVersion: sha256Digest,
            reason: z.enum(['condition_changed', 'bounded_time_due']),
            evidenceRefs: z.array(ownerTruthRefV1Schema),
          })
          .strict(),
        z
          .object({
            kind: z.literal('legacy_unbound'),
            blockingSequence: z.number().int().positive(),
            blockerEventDigest: sha256Digest,
            manifestDigest: sha256Digest,
          })
          .strict(),
      ]),
    })
    .strict(),
  eventBaseSchema
    .extend({
      type: z.literal('repair_outcome_linked'),
      outcome: PawFeelDirectRepairOutcomeV1Schema,
    })
    .strict(),
]);

export function parsePawFeelDispositionEvent(raw: unknown): PawFeelDispositionEvent {
  const event = PawFeelDispositionEventSchema.parse(raw);
  const fix =
    event.type === 'fix'
      ? event
      : event.type === 'signature_requested' && event.action.type === 'fix'
        ? event.action
        : undefined;
  if (fix) {
    if (!fix.repairBinding && (!fix.leaseId || fix.leaseGeneration === undefined))
      throw new Error('repair event has no exact binding');
    if (fix.repairBinding?.taskId !== undefined && fix.repairBinding.taskId !== fix.taskId)
      throw new Error('repair Task differs from binding');
    if (
      fix.repairBinding?.kind === 'task_assignment' &&
      (fix.leaseId !== undefined || fix.leaseGeneration !== undefined)
    )
      throw new Error('Task assignment event cannot carry a lease identity');
    if (
      fix.repairBinding?.kind === 'action_lease' &&
      fix.leaseId !== undefined &&
      (fix.leaseId !== fix.repairBinding.leaseId || fix.leaseGeneration !== fix.repairBinding.generation)
    )
      throw new Error('repair lease identity differs');
  }
  return event as PawFeelDispositionEvent;
}
