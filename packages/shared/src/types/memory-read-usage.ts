import { z } from 'zod';

const counts = z.object({
  read: z.number().int().nonnegative(),
  directRead: z.number().int().nonnegative(),
  cueDrill: z.number().int().nonnegative(),
});
export const memoryReadUsageSchema = z.object({
  sourceAnchor: z.string().min(1),
  revision: z.string().min(1),
  currentVersion: counts,
  allVersions: counts,
  /** Retained records with no bound consumer, excluded from the verified counts above. */
  recordedUnattributed: z.object({ currentVersion: counts, allVersions: counts }),
  historyComplete: z.literal(false),
  /** Reads absent from retained evidence remain unknowable, even when unbound rows can be counted. */
  unverifiedReadCount: z.null(),
  directReadRecordedSince: z.number().int().nonnegative(),
  recent: z.array(
    z.object({
      eventId: z.string(),
      occurredAt: z.number(),
      catId: z.string(),
      threadId: z.string().nullable(),
      kind: z.enum(['direct_read', 'cue_drill']),
      sourceRevision: z.string(),
    }),
  ),
});
export type MemoryReadUsage = z.infer<typeof memoryReadUsageSchema>;
