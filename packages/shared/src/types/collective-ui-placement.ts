import { z } from 'zod';
import { collectiveClientContextSchema } from './collective-context-bridge.js';

/** Public layout only. Private roster, thread, Task, queue and execution data stay in the Host DOM. */
export const collectiveUiPlacementSchema = collectiveClientContextSchema
  .pick({
    bridgeId: true,
    contextId: true,
    humanId: true,
    serviceInstanceId: true,
    collectiveId: true,
    channelId: true,
  })
  .extend({
    type: z.literal('collective:client-ui-placement'),
    contextRevision: z.number().int().positive(),
    slots: z
      .array(
        z
          .object({
            kind: z.enum(['roster', 'activity', 'receipt']),
            eventId: z.string().min(1).max(160).optional(),
            x: z.number().finite().min(-20000).max(20000),
            y: z.number().finite().min(-20000).max(20000),
            width: z.number().finite().nonnegative().max(20000),
            height: z.number().finite().nonnegative().max(20000),
          })
          .strict(),
      )
      .max(100),
  })
  .strict();
export type CollectiveUiPlacement = z.infer<typeof collectiveUiPlacementSchema>;
