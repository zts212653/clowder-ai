import { createHash } from 'node:crypto';
import { type RespondWithMediaVersion, respondWithMediaVersionSchema } from '@cat-cafe/shared';
import { z } from 'zod';

/** A direct owner command, not a callback, Queue retry, or a guess from a terminal child. */
export const publicationRecoveryCommandSchema = z
  .object({
    operationId: z.string().uuid(),
    expectedRequestRevision: z.number().int().positive(),
    expectedGeneration: z.number().int().nonnegative(),
    recoveryOfReceiptRef: z.string().min(1).max(1000),
    expectedPriorInvocationId: z.string().min(1).max(256),
    response: respondWithMediaVersionSchema,
  })
  .strict();

export type PublicationRecoveryCommand = z.infer<typeof publicationRecoveryCommandSchema>;
export interface PublicationResponseRecovery {
  generation: number;
  recoveryOfReceiptRef: string;
  operationId: string;
  expectedPriorInvocationId: string;
  response: RespondWithMediaVersion;
  responseFingerprint: string;
}

export function publicationResponseFingerprint(command: RespondWithMediaVersion): string {
  return createHash('sha256')
    .update(JSON.stringify(respondWithMediaVersionSchema.parse(command)))
    .digest('hex');
}

export function publicationRecoveryFingerprint(requestId: string, command: PublicationRecoveryCommand): string {
  return createHash('sha256')
    .update(JSON.stringify([requestId, publicationRecoveryCommandSchema.parse(command)]))
    .digest('hex');
}
