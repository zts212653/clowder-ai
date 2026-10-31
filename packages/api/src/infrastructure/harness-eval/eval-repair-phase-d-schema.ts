import { exactAssetVersionRefV1Schema, ownerTruthRefV1Schema } from '@cat-cafe/shared';
import { z } from 'zod';
import {
  approvalRequestSnapshotSchema,
  evalRepairOwnerLineageSchema,
  eventBaseSchema,
  isoDateTime,
  nonEmptyString,
} from './eval-lifecycle-schema-primitives.js';

const boundEventBaseSchema = eventBaseSchema.extend({
  caseId: nonEmptyString,
  proposalId: nonEmptyString,
  caseActionRef: nonEmptyString,
  approvalRef: ownerTruthRefV1Schema,
  requestSnapshot: approvalRequestSnapshotSchema,
  ownerLineage: evalRepairOwnerLineageSchema,
});

const interventionEventSchema = boundEventBaseSchema.extend({
  interventionReceiptRef: ownerTruthRefV1Schema,
});

export const repairInterventionChangedEventSchema = interventionEventSchema
  .extend({
    type: z.literal('repair_intervention_changed'),
    assetVersionRef: exactAssetVersionRefV1Schema,
    mainCommitSha: z.string().regex(/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/),
    loadedRuntimeRef: ownerTruthRefV1Schema,
    changedAt: isoDateTime,
    loadedAt: isoDateTime,
  })
  .strict();

export const repairInterventionNoChangeEventSchema = interventionEventSchema
  .extend({
    type: z.literal('repair_intervention_no_change'),
    reasonCode: z.enum([
      'evidence_already_satisfied',
      'risk_exceeds_benefit',
      'target_retired',
      'blocked_external',
      'other',
    ]),
    withdrawalCondition: nonEmptyString,
    nextEvalAt: isoDateTime,
    recordedAt: isoDateTime,
  })
  .strict();

export const repairOutcomeRecordedEventSchema = boundEventBaseSchema
  .extend({
    type: z.literal('repair_outcome_recorded'),
    interventionReceiptRef: ownerTruthRefV1Schema,
    outcomeReceiptRef: ownerTruthRefV1Schema,
    reevaluationRef: ownerTruthRefV1Schema,
    freshnessProofRef: ownerTruthRefV1Schema,
    outcome: z.enum([
      'effective_keep',
      'ineffective_tune',
      'ineffective_rollback',
      'rubric_reopen',
      'insufficient_observe',
    ]),
    loadedRuntimeRef: ownerTruthRefV1Schema.optional(),
    measuredAt: isoDateTime,
  })
  .strict();

export const repairMetabolismDecidedEventSchema = eventBaseSchema
  .extend({
    type: z.literal('repair_metabolism_decided'),
    caseId: nonEmptyString,
    proposalId: nonEmptyString,
    ownerLineage: evalRepairOwnerLineageSchema,
    outcomeReceiptRef: ownerTruthRefV1Schema,
    decision: z.enum(['keep', 'tune', 'rollback', 'sunset', 'no_change']),
    decisionAuthorityRef: ownerTruthRefV1Schema,
    decisionRef: ownerTruthRefV1Schema,
    executionReceiptRef: ownerTruthRefV1Schema.optional(),
    assetVersionRef: exactAssetVersionRefV1Schema.optional(),
  })
  .strict();
