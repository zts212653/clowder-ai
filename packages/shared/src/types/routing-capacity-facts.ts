import { z } from 'zod';
import {
  routingEpochMsSchema,
  routingIdentifierSchema,
  routingOwnerIdSchema,
  routingReferenceSchema,
} from './routing-context-common.js';

export const routingCapacityWindowV1Schema = z
  .object({
    poolId: routingIdentifierSchema,
    poolKind: z.enum(['codex-main', 'codex-spark', 'codex-review', 'codex-overflow', 'unknown']),
    // Account-owned observations do not prove an execution/model → provider limitId edge.
    // A future producer must supply exact frozen-binding evidence before this can become proven.
    applicability: z.literal('unknown'),
    freshness: z.enum(['fresh', 'stale']),
    kind: z.enum(['five_hour', 'seven_day', 'monthly', 'credits', 'unknown']),
    remainingPercent: z.number().finite().min(0).max(100).optional(),
    remainingAmount: z
      .object({ value: z.number().finite().nonnegative(), unit: z.literal('credits') })
      .strict()
      .optional(),
    resetAt: routingEpochMsSchema.optional(),
  })
  .strict()
  .superRefine((window, ctx) => {
    if (
      (window.remainingPercent === undefined) === (window.remainingAmount === undefined) ||
      (window.kind === 'credits') !== (window.remainingAmount !== undefined)
    )
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Exactly one quantity is required; credits are an amount, never a percentage',
      });
  });

export const routingAccountCapacityV1Schema = z
  .object({
    state: z.enum(['fresh', 'stale', 'unknown']),
    reason: z
      .enum([
        'binding_unknown',
        'principal_unverified',
        'provider_unverified',
        'observation_missing',
        'refresh_failed',
        'observation_stale',
        'reset_elapsed',
        'execution_binding_changed',
        'account_unavailable',
        'source_unavailable',
        'no_supported_pool',
      ])
      .optional(),
    accountLabel: z.string().trim().min(1).max(80).optional(),
    bindingRevision: routingReferenceSchema.optional(),
    evidenceRef: routingReferenceSchema.optional(),
    plan: z.string().trim().min(1).max(40).optional(),
    observedAt: routingEpochMsSchema.optional(),
    validUntil: routingEpochMsSchema.optional(),
    windows: z.array(routingCapacityWindowV1Schema).max(16),
  })
  .strict();

export const routingCapacityFactsV1Schema = z
  .object({
    v: z.literal(1),
    current: routingAccountCapacityV1Schema,
    switchRequired: z.array(routingAccountCapacityV1Schema).max(8),
  })
  .strict();

/** A post-enqueue observation never grants provider execution or proves recovery. */
export const routingQueueAdmissionReceiptV1Schema = z
  .object({
    v: z.literal(1),
    stage: z.literal('queue_admitted'),
    executionPreflight: z.literal('pending'),
    ownerId: routingOwnerIdSchema,
    observedAt: routingEpochMsSchema,
    snapshotRef: routingReferenceSchema.optional(),
    targets: z
      .array(
        z
          .object({
            targetCatId: routingIdentifierSchema,
            availabilityObservation: z.enum(['available', 'warned', 'unavailable']),
            reasons: z
              .array(
                z
                  .object({
                    code: routingIdentifierSchema,
                    summary: z.string().max(1000),
                    sourceRefs: z.array(routingReferenceSchema).max(32),
                  })
                  .strict(),
              )
              .max(32),
            capacityFacts: routingCapacityFactsV1Schema.optional(),
          })
          .strict(),
      )
      .max(64),
  })
  .strict();

export type RoutingCapacityWindowV1 = z.infer<typeof routingCapacityWindowV1Schema>;
export type RoutingAccountCapacityV1 = z.infer<typeof routingAccountCapacityV1Schema>;
export type RoutingCapacityFactsV1 = z.infer<typeof routingCapacityFactsV1Schema>;
export type RoutingQueueAdmissionReceiptV1 = z.infer<typeof routingQueueAdmissionReceiptV1Schema>;

/** Queue retains opaque observation provenance, not a second quota or decision ledger. */
export const routingAdmissionProvenanceV1Schema = z
  .object({
    stage: z.literal('queue_admitted'),
    observedAt: routingEpochMsSchema,
    snapshotRef: routingReferenceSchema.optional(),
    targets: z
      .array(z.object({ targetCatId: routingIdentifierSchema, factsRef: routingReferenceSchema }).strict())
      .max(64),
  })
  .strict();
export type RoutingAdmissionProvenanceV1 = z.infer<typeof routingAdmissionProvenanceV1Schema>;
