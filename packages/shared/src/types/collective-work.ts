import { z } from 'zod';
import { custodyAuthorityProvenanceV1Schema } from './entrusted-work-actions.js';

/** Separate owner opt-in; public participation never implies private execution. */
export const collectiveStandingWorkSchema = z
  .object({
    /** Legacy persisted address; authorization no longer selects an execution Thread. */
    threadId: z.string().min(1).max(240).optional(),
    requestingHumanIds: z.array(z.string().min(1).max(160)).min(1).max(100),
    channelIds: z.array(z.string().min(1).max(160)).min(1).max(100),
    expiresAt: z.string().datetime().nullable(),
  })
  .strict();
export type CollectiveStandingWork = z.infer<typeof collectiveStandingWorkSchema>;

/** A Host owner admission receipt, stored on its authenticated owner Message. No copied result target. */
export const collectiveOwnerAdmissionV1Schema = z
  .object({
    v: z.literal(1),
    sourceRef: z
      .string()
      .regex(/^message:.+/)
      .max(1000),
    catId: z.string().min(1).max(120),
    ownerAuthProvenance: z.literal('strict'),
    standingGrant: custodyAuthorityProvenanceV1Schema.optional(),
    /** First actual Host admission occurs now; immutable first assignment is lineage, never old permission. */
    bootstrapExecution: z
      .object({
        sourceRef: z
          .string()
          .regex(/^message:.+/)
          .max(1000),
        workId: z.string().startsWith('work_'),
        assignmentEventId: z.string().startsWith('evt_'),
        revision: z.number().int().min(2),
      })
      .strict()
      .optional(),
    /** Current execution receipt on the same Task; immutable birth admission remains intact. */
    execution: z
      .object({
        taskId: z.string().min(1).max(1000),
        workId: z.string().startsWith('work_'),
        assignmentEventId: z.string().startsWith('evt_'),
        revision: z.number().int().positive(),
      })
      .strict()
      .optional(),
  })
  .strict();

/** Server-produced execution trigger. Current Task truth is re-read before native/private access. */
export const collectiveWorkInvocationV1Schema = z
  .object({
    v: z.literal(1),
    taskId: z.string().min(1).max(1000),
    observedRevision: z.number().int().positive(),
    /** Defaults only when reading a persisted pre-round carrier. */
    resultRevision: z.number().int().positive().default(1),
    executionRevision: z.number().int().positive().default(1),
    executionRef: z
      .string()
      .regex(/^message:.+/)
      .max(1000)
      .optional(),
  })
  .strict();

export type CollectiveOwnerAdmissionV1 = z.infer<typeof collectiveOwnerAdmissionV1Schema>;
export type CollectiveWorkInvocationV1 = z.infer<typeof collectiveWorkInvocationV1Schema>;

/**
 * Server-produced home collaboration grant. It is attached only to an
 * authenticated callback Message written by the admitted Task owner and names
 * the exact home Cats that may continue the same private Work.
 */
export const collectiveWorkDelegationV1Schema = z
  .object({
    v: z.literal(1),
    taskId: z.string().min(1).max(1000),
    observedRevision: z.number().int().positive(),
    /** Result round inherited from the authenticated owner invocation. */
    resultRevision: z.number().int().positive().default(1),
    executionRevision: z.number().int().positive().default(1),
    executionRef: z
      .string()
      .regex(/^message:.+/)
      .max(1000)
      .optional(),
    ownerCatId: z.string().min(1).max(120),
    targetCatIds: z.array(z.string().min(1).max(120)).min(1).max(20),
  })
  .strict()
  .superRefine((value, context) => {
    if (new Set(value.targetCatIds).size !== value.targetCatIds.length) {
      context.addIssue({ code: 'custom', message: 'Collective Work delegation targets must be unique' });
    }
    if (value.targetCatIds.includes(value.ownerCatId)) {
      context.addIssue({ code: 'custom', message: 'Collective Work delegation must name another home Cat' });
    }
  });
export type CollectiveWorkDelegationV1 = z.infer<typeof collectiveWorkDelegationV1Schema>;

export const collectiveWorkBindingSchema = collectiveWorkInvocationV1Schema
  .extend({
    sourceRef: z.string().regex(/^message:.+/),
    authorityRef: z.string().regex(/^message:.+/),
  })
  .strict();
export type CollectiveWorkBinding = z.infer<typeof collectiveWorkBindingSchema>;
