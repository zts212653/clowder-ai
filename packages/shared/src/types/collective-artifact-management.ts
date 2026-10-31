import { z } from 'zod';

const id = z.string().trim().min(1).max(256);
const positive = z.number().int().positive().safe();
export const readCollectiveArtifactManagementSchema = z
  .object({
    serviceInstanceId: id,
    collectiveId: id,
    artifactId: id,
    offset: z.number().int().nonnegative().safe().default(0),
    limit: z.number().int().min(1).max(50).default(30),
    snapshot: z
      .string()
      .regex(/^sha256:[a-f0-9]{64}$/)
      .optional(),
  })
  .strict();

/** Manager-only metadata: no endpoint credentials, owner scope, prepared proofs or content bytes. */
export const collectiveArtifactManagementSchema = z
  .object({
    serviceInstanceId: id,
    collectiveId: id,
    artifactId: id,
    canManageAccess: z.boolean(),
    canManageCustody: z.boolean(),
    custodyRevision: positive,
    custodianHumanId: id.optional(),
    custodianCafe: z
      .object({ connectionId: id, endpointLabel: z.string().min(1).max(160) })
      .strict()
      .optional(),
    custodyAvailable: z.boolean(),
    snapshot: z.string().regex(/^sha256:[a-f0-9]{64}$/),
    offset: z.number().int().nonnegative().safe(),
    total: z.number().int().nonnegative().safe(),
    nextOffset: z.number().int().positive().safe().optional(),
    members: z
      .array(
        z
          .object({
            humanId: id,
            displayName: z.string().min(1),
            access: z.enum(['read', 'apply', 'revoked']).optional(),
            accessRevision: positive.optional(),
            canReceiveCustody: z.boolean(),
          })
          .strict(),
      )
      .max(50),
    transfer: z
      .object({
        transferId: id,
        state: z.enum(['offered', 'source_prepared', 'target_ready', 'committed', 'cancelled']),
        sourceHumanId: id,
        targetHumanId: id,
        targetCafe: z
          .object({ connectionId: id, endpointLabel: z.string().min(1).max(160) })
          .strict()
          .optional(),
        sourceFinalized: z.boolean(),
        targetFinalized: z.boolean(),
        updatedAt: z.string().datetime(),
      })
      .strict()
      .optional(),
  })
  .strict();
export type CollectiveArtifactManagement = z.infer<typeof collectiveArtifactManagementSchema>;
