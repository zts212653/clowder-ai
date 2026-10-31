import { z } from 'zod';

const identity = z
  .object({
    userId: z.string().min(1),
    workspaceId: z.string().min(1),
    email: z.string().optional(),
    planType: z.string().optional(),
  })
  .strict();
export const codexManagedAccountSchema = z
  .object({
    kind: z.literal('managed'),
    layoutVersion: z.literal(1),
    credentialHome: z.string().min(1),
    stateRoot: z.string().min(1),
    sqliteHome: z.string().min(1),
    prepared: z.boolean(),
    identity: identity.optional(),
    attempt: z
      .object({
        id: z.string().uuid(),
        revision: z.number().int().positive(),
        ownerBootId: z.string().uuid(),
        ownerPid: z.number().int().positive(),
        ownerStartedAt: z.string().min(1).max(128),
        state: z.enum([
          'preparing',
          'queued',
          'waiting',
          'review',
          'success',
          'reused',
          'canceled',
          'interrupted',
          'failed',
          'timeout',
          'superseded',
        ]),
        credentialHome: z.string().min(1),
        createdAt: z.number(),
        updatedAt: z.number(),
        identity: identity.optional(),
        duplicateAccountRef: z.string().optional(),
        error: z.string().optional(),
      })
      .strict()
      .optional(),
  })
  .strict();
