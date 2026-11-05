import { z } from 'zod';
import {
  COLLECTIVE_CUSTODY_MAX_PAGES,
  collectiveCustodyEndpointSchema,
  collectiveCustodyPageSchema,
  collectiveCustodyTargetSchema,
  collectiveCustodyTransferSchema,
} from './collective-artifact-custody.js';

const id = z.string().min(1).max(256);
const index = z
  .number()
  .int()
  .nonnegative()
  .max(COLLECTIVE_CUSTODY_MAX_PAGES - 1);
export const collectiveCustodyPageRequestSchema = collectiveCustodyTargetSchema.extend({ index }).strict();
export const collectiveCustodyPageOperationSchema = z
  .object({
    relayRef: id,
    transfer: collectiveCustodyTransferSchema,
    index,
    expiresAt: z.number().int().positive().safe(),
  })
  .strict();
export type CollectiveCustodyPageOperation = z.infer<typeof collectiveCustodyPageOperationSchema>;
export const collectiveCustodyPageResponseSchema = z.discriminatedUnion('status', [
  collectiveCustodyEndpointSchema
    .extend({ relayRef: id, status: z.literal('ok'), page: collectiveCustodyPageSchema })
    .strict(),
  collectiveCustodyEndpointSchema
    .extend({
      relayRef: id,
      status: z.literal('error'),
      error: z.enum(['access_denied', 'owner_unavailable', 'invalid_request']),
    })
    .strict(),
]);
