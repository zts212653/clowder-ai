import { z } from 'zod';

const counts = z.object({ opening: z.number().int().nonnegative(), read: z.number().int().nonnegative() });
/** Recorded observations, never a claim of complete history or model adoption. */
export const profileUsageSummarySchema = z.object({
  memoryId: z.string(),
  revision: z.string(),
  openingMode: z.enum(['enabled', 'on_demand']),
  currentVersion: counts,
  allVersions: counts,
  historyComplete: z.literal(false),
  directReadRecordedSince: z.number().nonnegative(),
  earliestRecordedAt: z.number().nonnegative().nullable(),
  recent: z.array(
    z.object({
      eventId: z.string(),
      kind: z.enum(['opening', 'read']),
      occurredAt: z.number().nonnegative(),
      sourceRevision: z.string(),
      catId: z.string(),
      threadId: z.string().nullable(),
    }),
  ),
});
export type ProfileUsageSummary = z.infer<typeof profileUsageSummarySchema>;
