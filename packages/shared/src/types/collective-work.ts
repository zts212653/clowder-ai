import { z } from 'zod';
import { custodyAuthorityProvenanceV1Schema } from './entrusted-work-actions.js';

/** Separate owner opt-in; public participation never implies private execution. */
export const collectiveStandingWorkSchema = z
  .object({
    threadId: z.string().min(1).max(240),
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
  })
  .strict();

/** Server-produced execution trigger. Current Task truth is re-read before native/private access. */
export const collectiveWorkInvocationV1Schema = z
  .object({
    v: z.literal(1),
    taskId: z.string().min(1).max(1000),
    observedRevision: z.number().int().positive(),
  })
  .strict();

export type CollectiveOwnerAdmissionV1 = z.infer<typeof collectiveOwnerAdmissionV1Schema>;
export type CollectiveWorkInvocationV1 = z.infer<typeof collectiveWorkInvocationV1Schema>;

export const collectiveWorkBindingSchema = collectiveWorkInvocationV1Schema
  .extend({
    sourceRef: z.string().regex(/^message:.+/),
    authorityRef: z.string().regex(/^message:.+/),
  })
  .strict();
export type CollectiveWorkBinding = z.infer<typeof collectiveWorkBindingSchema>;
