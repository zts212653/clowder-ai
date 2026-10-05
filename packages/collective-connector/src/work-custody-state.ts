import {
  collectiveAcceptWorkRequestSchema,
  collectiveContinueWorkRequestSchema,
  collectiveSourceIdentitySchema,
  collectiveWorkHostAdmissionRequestSchema,
  collectiveWorkPolicySchema,
} from '@cat-cafe/shared';
import { z } from 'zod';

export const workCustodySchema = z
  .object({
    adoptedPolicy: collectiveWorkPolicySchema.optional(),
    adoptedAt: z.string().datetime().optional(),
    blockedGrantRefs: z.array(z.string()),
    revocations: z.array(
      z
        .object({
          requestId: z.string(),
          expectedRevision: z.number().int().positive(),
          grantRefs: z.array(z.string()),
          targets: z
            .array(z.object({ grantRef: z.string(), grantRevision: z.number().int().positive() }).strict())
            .optional(),
          status: z.enum(['pending', 'confirmed', 'superseded', 'blocked']),
          replacementRequestId: z.string().optional(),
          failureCode: z.string().optional(),
        })
        .strict(),
    ),
    acceptances: z.array(
      z
        .object({
          source: collectiveSourceIdentitySchema,
          request: collectiveAcceptWorkRequestSchema,
          status: z.enum(['prepared', 'accepted', 'blocked']),
          workId: z.string().optional(),
          assignmentEventId: z.string().optional(),
          failureCode: z.string().optional(),
          createdAt: z.string().datetime(),
        })
        .strict(),
    ),
    hostAdmissions: z.array(
      z
        .object({
          request: collectiveWorkHostAdmissionRequestSchema,
          status: z.enum(['pending', 'confirmed', 'blocked']),
          failureCode: z.string().optional(),
        })
        .strict(),
    ),
    continuations: z
      .array(
        z
          .object({
            source: collectiveSourceIdentitySchema,
            request: collectiveContinueWorkRequestSchema,
            status: z.enum(['prepared', 'accepted', 'blocked']),
            executionRevision: z.number().int().positive().optional(),
            failureCode: z.string().optional(),
            createdAt: z.string().datetime(),
          })
          .strict(),
      )
      .default([]),
  })
  .strict();

export type ConnectorWorkCustody = z.infer<typeof workCustodySchema>;
export const emptyWorkCustody = (): ConnectorWorkCustody => ({
  blockedGrantRefs: [],
  revocations: [],
  acceptances: [],
  hostAdmissions: [],
  continuations: [],
});
