import { z } from 'zod';
import { collectiveConnectionIdSchema, collectiveHumanIdSchema } from './collective.js';

export const collectiveCollaborationActorSchema = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal('human'),
      humanId: collectiveHumanIdSchema,
      displayName: z.string().trim().min(1).max(120),
    })
    .strict(),
  z
    .object({
      kind: z.literal('agent'),
      humanId: collectiveHumanIdSchema,
      humanDisplayName: z.string().trim().min(1).max(120),
      connectionId: collectiveConnectionIdSchema,
      catId: z.string().trim().min(1).max(120),
      displayName: z.string().trim().min(1).max(120),
    })
    .strict(),
]);
