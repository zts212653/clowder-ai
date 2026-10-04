import { z } from 'zod';
import { evolutionExplorationRefSchema } from './capability-evolution-exploration-record.js';

/** The original Program/experiment/record/media coordinate, not a file locator or chat message. */
export const evolutionMediaLocatorSchema = z
  .object({
    programId: z.string().regex(/^evolution-program:[a-f0-9]{32}$/),
    experimentRef: evolutionExplorationRefSchema,
    recordRef: evolutionExplorationRefSchema,
    mediaRef: evolutionExplorationRefSchema.refine((ref) => /^[a-f0-9]{64}$/.test(ref.version ?? '')),
  })
  .strict();
export type EvolutionMediaLocator = z.infer<typeof evolutionMediaLocatorSchema>;

/** Created only after the user confirms a real modification request and its execution conversation. */
export const evolutionMediaSnapshotSourceSchema = z
  .object({
    kind: z.literal('evolution-snapshot'),
    threadId: z.string().trim().min(1).max(256),
    locator: evolutionMediaLocatorSchema,
  })
  .strict();
export type EvolutionMediaSnapshotSource = z.infer<typeof evolutionMediaSnapshotSourceSchema>;
