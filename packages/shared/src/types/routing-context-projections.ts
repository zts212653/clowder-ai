import { z } from 'zod';
import {
  addRoutingDuplicateIssues,
  ROUTING_CONTEXT_VERSION,
  routingEpochMsSchema,
  routingIdentifierSchema,
  routingOwnerIdSchema,
  routingReferenceSchema,
  routingSummarySchema,
} from './routing-context-common.js';
import { capabilityProfileRevisionRefV1Schema, routingCandidateBindingV1Schema } from './routing-context-inputs.js';

export const routingReasonV1Schema = z
  .object({
    code: routingIdentifierSchema,
    summary: routingSummarySchema,
    sourceRefs: z.array(routingReferenceSchema).min(1).max(32),
  })
  .strict();

const routingCandidateProfileV1Schema = z.discriminatedUnion('state', [
  z.object({ state: z.literal('applied'), revision: capabilityProfileRevisionRefV1Schema }).strict(),
  z.object({ state: z.literal('absent') }).strict(),
]);

const routingCandidateSnapshotV1Schema = z
  .object({
    binding: routingCandidateBindingV1Schema,
    profile: routingCandidateProfileV1Schema,
    availability: z.enum(['available', 'scarce', 'degraded', 'unavailable', 'unknown']),
    freshness: z.enum(['fresh', 'stale', 'unknown']),
    reasons: z.array(routingReasonV1Schema).max(32),
    matchedPreferences: z
      .array(
        z
          .object({
            revisionId: routingIdentifierSchema,
            lifecycle: z.enum(['active', 'review_due']),
          })
          .strict(),
      )
      .max(32),
    effect: z.enum(['eligible', 'advisory', 'blocked']),
  })
  .strict()
  .superRefine((candidate, ctx) => {
    if (candidate.profile.state === 'applied' && candidate.profile.revision.catId !== candidate.binding.catId) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['profile', 'revision', 'catId'],
        message: 'an applied profile revision must belong to the bound candidate',
      });
    }
    const expectedEffect =
      candidate.availability === 'unavailable'
        ? 'blocked'
        : candidate.availability === 'available'
          ? 'eligible'
          : 'advisory';
    if (candidate.effect !== expectedEffect) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['effect'],
        message: `availability ${candidate.availability} requires ${expectedEffect} effect`,
      });
    }
    if (candidate.effect !== 'eligible' && candidate.reasons.length === 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['reasons'],
        message: 'advisory and blocked candidates require explainable reasons',
      });
    }
  });

export const routingContextSnapshotV1Schema = z
  .object({
    v: z.literal(ROUTING_CONTEXT_VERSION),
    ownerId: routingOwnerIdSchema,
    observedAt: routingEpochMsSchema,
    catalogRevision: routingReferenceSchema,
    candidates: z.array(routingCandidateSnapshotV1Schema).max(64),
  })
  .strict()
  .superRefine((snapshot, ctx) => {
    addRoutingDuplicateIssues(
      snapshot.candidates.map((candidate) => candidate.binding.catId),
      ['candidates'],
      ctx,
    );
  });

const routingPreflightTargetV1Schema = z
  .object({
    targetCatId: routingOwnerIdSchema,
    disposition: z.enum(['allowed', 'warned', 'rejected']),
    reasons: z.array(routingReasonV1Schema).max(32),
    alternatives: z
      .array(
        z
          .object({
            catId: routingOwnerIdSchema,
            reasonRefs: z.array(routingReferenceSchema).min(1).max(16),
          })
          .strict(),
      )
      .max(32),
  })
  .strict()
  .superRefine((target, ctx) => {
    if (target.disposition !== 'allowed' && target.reasons.length === 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['reasons'],
        message: 'warned and rejected targets require explainable reasons',
      });
    }
    const alternativeIds = target.alternatives.map((alternative) => alternative.catId);
    addRoutingDuplicateIssues(alternativeIds, ['alternatives'], ctx);
    alternativeIds.forEach((catId, index) => {
      if (catId === target.targetCatId) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['alternatives', index, 'catId'],
          message: 'the original target is not an alternative',
        });
      }
    });
  });

export const routingPreflightDecisionV1Schema = z
  .object({
    v: z.literal(ROUTING_CONTEXT_VERSION),
    ownerId: routingOwnerIdSchema,
    observedAt: routingEpochMsSchema,
    resolverState: z.enum(['fresh', 'degraded']),
    snapshotRef: routingReferenceSchema.optional(),
    targets: z.array(routingPreflightTargetV1Schema).min(1).max(64),
  })
  .strict()
  .superRefine((decision, ctx) => {
    addRoutingDuplicateIssues(
      decision.targets.map((target) => target.targetCatId),
      ['targets'],
      ctx,
    );
    if (decision.resolverState === 'degraded') {
      decision.targets.forEach((target, index) => {
        if (target.disposition === 'rejected') {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ['targets', index, 'disposition'],
            message: 'a degraded advisory resolver cannot reject a target',
          });
        }
      });
    }
  });

export type RoutingReasonV1 = z.infer<typeof routingReasonV1Schema>;
export type RoutingContextSnapshotV1 = z.infer<typeof routingContextSnapshotV1Schema>;
export type RoutingPreflightDecisionV1 = z.infer<typeof routingPreflightDecisionV1Schema>;
