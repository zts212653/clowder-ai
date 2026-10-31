import { z } from 'zod';

/** Navigation only; this locator grants no project or content authority. */
export const collectiveProjectArtifactReturnSchema = z
  .object({
    roadmapId: z.string().trim().min(1).max(256),
    channelId: z.string().trim().min(1).max(120),
    referenceId: z.string().trim().min(1).max(256).optional(),
  })
  .strict();
