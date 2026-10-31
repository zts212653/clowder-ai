import { ownerTruthRefV1Schema } from '@cat-cafe/shared';
import { z } from 'zod';
import {
  approvalRequestOriginSchema,
  approvalRequestSnapshotSchema,
  EvalLifecycleRefSchema,
  evalRepairOwnerLineageSchema,
  eventBaseSchema,
  isoDateTime,
  nonEmptyString,
} from './eval-lifecycle-schema-primitives.js';
import {
  repairInterventionChangedEventSchema,
  repairInterventionNoChangeEventSchema,
  repairMetabolismDecidedEventSchema,
  repairOutcomeRecordedEventSchema,
} from './eval-repair-phase-d-schema.js';

export {
  type EvalLifecycleActor,
  EvalLifecycleActorSchema,
  type EvalLifecycleRef,
  EvalLifecycleRefSchema,
} from './eval-lifecycle-schema-primitives.js';

export const EvalVerdictLifecycleStatusSchema = z.enum([
  'open',
  'acknowledged',
  'action_planned',
  'fix_landed',
  'main_landed',
  'live_active',
  'monitoring',
  'reeval_pending',
  'resolved',
  'suppressed_with_reason',
  'escalated',
]);

export type EvalVerdictLifecycleStatus = z.infer<typeof EvalVerdictLifecycleStatusSchema>;

const legacyContinuitySchema = z
  .object({
    ownerResponseRefs: z.array(EvalLifecycleRefSchema),
    planRefs: z.array(EvalLifecycleRefSchema),
    actionRefs: z.array(EvalLifecycleRefSchema),
    reevalRefs: z.array(EvalLifecycleRefSchema),
  })
  .strict();

const plainEvent = <T extends string>(type: T) => eventBaseSchema.extend({ type: z.literal(type) }).strict();

export const EvalLifecycleEventSchema = z.discriminatedUnion('type', [
  plainEvent('verdict_opened'),
  eventBaseSchema
    .extend({
      type: z.literal('verdict_cycle_observed'),
      caseId: nonEmptyString,
      cycleCreatedAt: isoDateTime,
    })
    .strict(),
  eventBaseSchema
    .extend({
      type: z.literal('case_ready_for_proposal'),
      caseId: nonEmptyString,
      caseActionRef: nonEmptyString,
      findingArtifactRef: nonEmptyString,
      supersedesProposalId: nonEmptyString.optional(),
      requestSnapshot: approvalRequestSnapshotSchema.optional(),
    })
    .strict(),
  eventBaseSchema
    .extend({
      type: z.literal('approval_proposed'),
      caseId: nonEmptyString,
      proposalId: nonEmptyString,
      caseActionRef: nonEmptyString,
      requestIdempotencyRef: nonEmptyString,
      requestedAuthority: z.enum(['repair', 'accept_no_change', 'extend_budget', 'change_scope', 'change_owner']),
      findingArtifactRef: nonEmptyString,
      expectedChange: nonEmptyString,
      costAndRollback: nonEmptyString,
      withdrawalCondition: nonEmptyString,
      summary: nonEmptyString,
      detail: z.record(z.unknown()),
      requestOrigin: approvalRequestOriginSchema,
      requestSnapshot: approvalRequestSnapshotSchema,
      ownerLineage: evalRepairOwnerLineageSchema.optional(),
      supersedesProposalId: nonEmptyString.optional(),
    })
    .strict(),
  eventBaseSchema
    .extend({
      type: z.literal('approval_anchored'),
      caseId: nonEmptyString,
      proposalId: nonEmptyString,
      approvalEnvelopeRef: nonEmptyString,
      approvalCardRef: z.object({ threadId: nonEmptyString, messageId: nonEmptyString }).strict(),
    })
    .strict(),
  eventBaseSchema
    .extend({
      type: z.literal('approval_publication_tombstoned'),
      caseId: nonEmptyString,
      proposalId: nonEmptyString,
      failedAt: isoDateTime,
    })
    .strict(),
  eventBaseSchema
    .extend({
      type: z.literal('approval_decided'),
      caseId: nonEmptyString,
      proposalId: nonEmptyString,
      resolution: z.enum(['accepted', 'rejected', 'closed_without_decision']),
      decisionKind: z.enum(['accept', 'reject', 'withdraw']),
      reasonCode: z.enum([
        'accepted_as_proposed',
        'wrong_target',
        'insufficient_evidence',
        'not_now',
        'cost_too_high',
        'other',
      ]),
      reasonText: nonEmptyString.optional(),
      decidedByUserId: nonEmptyString,
      approvalRef: ownerTruthRefV1Schema,
      requestSnapshot: approvalRequestSnapshotSchema,
    })
    .strict(),
  eventBaseSchema
    .extend({
      type: z.literal('approval_superseded'),
      caseId: nonEmptyString,
      proposalId: nonEmptyString,
      drift: z.enum(['owner', 'authorization', 'target']),
      freshCaseActionRef: nonEmptyString,
      decisionRef: ownerTruthRefV1Schema,
      requestSnapshot: approvalRequestSnapshotSchema,
      dispatchRejectionRef: ownerTruthRefV1Schema.optional(),
    })
    .strict(),
  eventBaseSchema
    .extend({
      type: z.literal('approval_materialization_started'),
      caseId: nonEmptyString,
      proposalId: nonEmptyString,
      approvalRef: ownerTruthRefV1Schema,
      requestSnapshot: approvalRequestSnapshotSchema,
      dispatchSnapshot: approvalRequestSnapshotSchema,
      dispatchId: nonEmptyString,
    })
    .strict(),
  eventBaseSchema
    .extend({
      type: z.literal('approval_materialized'),
      caseId: nonEmptyString,
      proposalId: nonEmptyString,
      approvalRef: ownerTruthRefV1Schema,
      requestSnapshot: approvalRequestSnapshotSchema,
      dispatchSnapshot: approvalRequestSnapshotSchema,
      dispatchId: nonEmptyString,
      taskRef: ownerTruthRefV1Schema,
      leaseRef: ownerTruthRefV1Schema,
      custodyReceiptRef: ownerTruthRefV1Schema,
    })
    .strict(),
  eventBaseSchema
    .extend({
      type: z.literal('legacy_case_migrated'),
      caseId: nonEmptyString,
      reviewedAt: isoDateTime,
      legacyVerdictIds: z.array(nonEmptyString).min(1),
      disposition: z.enum(['repair', 'monitor']),
      legacyContinuity: legacyContinuitySchema.optional(),
    })
    .strict(),
  eventBaseSchema
    .extend({
      type: z.literal('responsibility_blocked'),
      caseId: nonEmptyString,
      reasonCode: z.enum(['feature_thread_not_found', 'feature_thread_ambiguous']),
      featureId: nonEmptyString,
      ownerCatId: nonEmptyString,
      candidateThreadIds: z.array(nonEmptyString),
    })
    .strict(),
  eventBaseSchema
    .extend({
      type: z.literal('responsibility_bound'),
      caseId: nonEmptyString,
      taskId: nonEmptyString,
      leaseId: nonEmptyString,
      leaseGeneration: z.number().int().positive(),
    })
    .strict(),
  eventBaseSchema
    .extend({
      type: z.literal('custody_dispatch_blocked'),
      caseId: nonEmptyString,
      stage: z.enum(['responsibility', 'reevaluation']),
      reasonCode: z.enum(['carrier_persist_failed', 'carrier_delivery_failed', 'carrier_not_enqueued']),
      taskId: nonEmptyString,
      leaseId: nonEmptyString,
      leaseGeneration: z.number().int().positive(),
      carrierMessageId: nonEmptyString.optional(),
    })
    .strict(),
  eventBaseSchema
    .extend({
      type: z.literal('owner_reassigned'),
      targetOwnerCatId: nonEmptyString,
    })
    .strict(),
  plainEvent('owner_acknowledged'),
  plainEvent('action_planned'),
  plainEvent('fix_recorded'),
  eventBaseSchema
    .extend({ type: z.literal('main_landed'), caseId: nonEmptyString, commitSha: z.string().regex(/^[a-f0-9]{7,64}$/) })
    .strict(),
  eventBaseSchema
    .extend({ type: z.literal('live_active'), caseId: nonEmptyString, commitSha: z.string().regex(/^[a-f0-9]{7,64}$/) })
    .strict(),
  eventBaseSchema
    .extend({
      type: z.literal('reeval_requested'),
      dueAt: isoDateTime,
      assignedEvalCatId: nonEmptyString.optional(),
      reevalTaskId: nonEmptyString.optional(),
      reevalLeaseId: nonEmptyString.optional(),
      reevalLeaseGeneration: z.number().int().positive().optional(),
    })
    .strict(),
  eventBaseSchema.extend({ type: z.literal('reeval_passed'), assignedEvalCatId: nonEmptyString }).strict(),
  eventBaseSchema.extend({ type: z.literal('reeval_failed'), assignedEvalCatId: nonEmptyString }).strict(),
  repairInterventionChangedEventSchema,
  repairInterventionNoChangeEventSchema,
  repairOutcomeRecordedEventSchema,
  repairMetabolismDecidedEventSchema,
  plainEvent('cvo_suppressed'),
  eventBaseSchema
    .extend({
      type: z.literal('sla_escalated'),
      stage: z.enum(['acknowledgement', 'reevaluation']),
      dueAt: isoDateTime,
    })
    .strict(),
]);

export type EvalLifecycleEvent = z.infer<typeof EvalLifecycleEventSchema>;
