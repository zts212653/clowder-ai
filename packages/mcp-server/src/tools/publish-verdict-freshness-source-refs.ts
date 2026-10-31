import { z } from 'zod';

const safeIds = z
  .array(
    z
      .string()
      .min(1)
      .refine((value) => !/[\r\n]/.test(value), 'id must not contain newlines'),
  )
  .min(1)
  .max(50);

/** KEEP IN SYNC: API FreshnessReplaySelector + validateFreshnessReplaySelector. */
export const freshnessReplaySourceRefsShape = z
  .object({
    kind: z.literal('freshness-closure-replay'),
    windowStartMs: z.number().finite().describe('Inclusive epoch ms window start for durable closure replay.'),
    windowEndMs: z.number().finite().describe('Exclusive epoch ms window end; API enforces ordering and 31-day cap.'),
    threadIds: safeIds.optional().describe('Optional live-closure thread narrowing.'),
  })
  .strict()
  .describe('eval:freshness sourceRefs — server-resolved durable closure and structural fixture replay.');

export type FreshnessReplaySourceRefs = z.infer<typeof freshnessReplaySourceRefsShape>;
