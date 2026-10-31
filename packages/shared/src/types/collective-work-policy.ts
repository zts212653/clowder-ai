import { z } from 'zod';
import {
  collectiveConnectionCoordinatesSchema,
  collectiveEventIdSchema,
  collectiveHumanIdSchema,
} from './collective.js';

const ref = z.string().trim().min(1).max(240);
const ids = z.array(ref).min(1).max(100);

/** Permission scope has no execution address. Exact source IDs distinguish once from standing rules. */
export const collectiveWorkGrantScopeSchema = z
  .object({
    grantRef: ref,
    catIds: ids,
    channelIds: ids,
    requestingHumanIds: z.union([z.literal('channel_members'), ids]),
    requestKinds: ids,
    /** Human-registered class exception; omitted grants inherit the policy default. */
    decisionMode: z.enum(['automatic', 'manual']).optional(),
    sourceEventIds: z.array(collectiveEventIdSchema).min(1).max(100).optional(),
    expiresAt: z.string().datetime().nullable(),
  })
  .strict();

export const collectiveRegisteredWorkGrantSchema = collectiveWorkGrantScopeSchema
  .extend({
    grantRevision: z.number().int().positive(),
    status: z.enum(['active', 'revoked']),
  })
  .strict();

export const collectiveWorkPolicySchema = z
  .object({
    revision: z.number().int().positive(),
    ownerHumanId: collectiveHumanIdSchema,
    decisionMode: z.enum(['automatic', 'manual']).default('automatic'),
    grants: z.array(collectiveRegisteredWorkGrantSchema),
    history: z.array(
      z
        .object({
          requestId: ref,
          fingerprint: z.string().length(64),
          revision: z.number().int().positive(),
          actor: z.enum(['human_owner', 'host_revocation']),
          at: z.string().datetime(),
        })
        .strict(),
    ),
  })
  .strict();

export const collectiveRegisterWorkPolicyRequestSchema = collectiveConnectionCoordinatesSchema
  .extend({
    expectedRevision: z.number().int().nonnegative(),
    requestId: ref,
    decisionMode: z.enum(['automatic', 'manual']).default('automatic'),
    grants: z.array(collectiveWorkGrantScopeSchema).max(100),
  })
  .strict()
  .superRefine((input, context) => {
    if (new Set(input.grants.map((grant) => grant.grantRef)).size !== input.grants.length)
      context.addIssue({ code: 'custom', message: 'Each owner grant needs one stable reference' });
  });

export const collectiveRevokeWorkPolicyRequestSchema = collectiveConnectionCoordinatesSchema
  .extend({
    expectedRevision: z.number().int().positive(),
    requestId: ref,
    grantRefs: ids,
  })
  .strict();

export const collectiveAcceptWorkRequestSchema = collectiveConnectionCoordinatesSchema
  .extend({
    sourceEventId: collectiveEventIdSchema,
    requestId: ref,
    catId: ref,
    participationRevision: z.number().int().positive(),
    sessionRef: ref,
    grantRef: ref,
    grantRevision: z.number().int().positive(),
    requestKind: ref,
    title: z.string().trim().min(1).max(200),
    intendedOutcome: z.string().trim().min(1).max(32_000),
  })
  .strict();

export const collectiveWorkHostAdmissionRequestSchema = collectiveConnectionCoordinatesSchema
  .extend({
    workId: ref.regex(/^work_[A-Za-z0-9_-]{8,}$/),
    assignmentEventId: collectiveEventIdSchema,
    operationRef: ref,
    grantRef: ref,
    grantRevision: z.number().int().positive(),
    executionRevision: z.number().int().positive().optional(),
    disposition: z
      .object({
        state: z.enum(['admitted', 'rejected']),
        receiptRef: ref,
        reason: z.string().trim().min(1).max(500).optional(),
      })
      .strict(),
  })
  .strict();

export const collectiveContinueWorkRequestSchema = collectiveAcceptWorkRequestSchema
  .omit({ title: true, intendedOutcome: true })
  .extend({
    workId: ref.regex(/^work_[A-Za-z0-9_-]{8,}$/),
    expectedRevision: z.number().int().positive(),
    kind: z.enum(['resume', 'revision']),
    resultEventId: collectiveEventIdSchema.optional(),
    resultRevision: z.number().int().positive().optional(),
  })
  .strict();

export type CollectiveWorkGrantScope = z.infer<typeof collectiveWorkGrantScopeSchema>;
export type CollectiveRegisteredWorkGrant = z.infer<typeof collectiveRegisteredWorkGrantSchema>;
export type CollectiveWorkPolicy = z.infer<typeof collectiveWorkPolicySchema>;
export type CollectiveRegisterWorkPolicyRequest = z.infer<typeof collectiveRegisterWorkPolicyRequestSchema>;
export type CollectiveRevokeWorkPolicyRequest = z.infer<typeof collectiveRevokeWorkPolicyRequestSchema>;
export type CollectiveAcceptWorkRequest = z.infer<typeof collectiveAcceptWorkRequestSchema>;
export type CollectiveWorkHostAdmissionRequest = z.infer<typeof collectiveWorkHostAdmissionRequestSchema>;
export type CollectiveContinueWorkRequest = z.infer<typeof collectiveContinueWorkRequestSchema>;
