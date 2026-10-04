import { z } from 'zod';
import {
  collectiveConnectionIdSchema,
  collectiveEndpointIdSchema,
  collectiveHumanActorSchema,
  collectiveHumanIdSchema,
} from './collective.js';

/** Public membership, not live presence or a Host execution/credential projection. */
export const collectiveMemberDirectorySchema = z
  .object({
    humans: z.array(
      collectiveHumanActorSchema
        .omit({ kind: true })
        .extend({ role: z.enum(['steward', 'member']) })
        .strict(),
    ),
    cafes: z.array(
      z
        .object({
          connectionId: collectiveConnectionIdSchema,
          endpointId: collectiveEndpointIdSchema,
          endpointLabel: z.string().min(1).max(160),
          humanId: collectiveHumanIdSchema,
        })
        .strict(),
    ),
  })
  .strict();

export type CollectiveMemberDirectory = z.infer<typeof collectiveMemberDirectorySchema>;
