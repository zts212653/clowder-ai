import {
  evolutionExplorationNodeRefSchema,
  evolutionExplorationRefSchema,
  evolutionExplorationSelectionSchema,
  exactAssetVersionRefV1Schema,
  ownerTruthRefV1Schema,
} from '@cat-cafe/shared';
import { z } from 'zod';

const baseBinding = {
  nodeRef: evolutionExplorationNodeRefSchema,
  title: z.string().min(1).max(240),
  experimentRef: evolutionExplorationRefSchema.optional(),
};
export const explorationBindingSchema = z.discriminatedUnion('kind', [
  z.object({ ...baseBinding, kind: z.literal('owner_version'), versionRef: exactAssetVersionRefV1Schema }).strict(),
  z.object({ ...baseBinding, kind: z.literal('public_archive') }).strict(),
]);
export const explorationDraftSchema = z
  .object({
    text: z.string().max(8_000),
    intent: z.enum(['explore', 'retest', 'adopt']),
    binding: explorationBindingSchema.optional(),
  })
  .strict();
export const explorationRequestContextSchema = z
  .object({
    workspaceId: z.string().min(1).max(240),
    programId: z.string().min(1).max(240),
    cycle: z.number().int().min(1).optional(),
    objectRef: ownerTruthRefV1Schema,
    threadId: z.string().min(1).max(240),
    catId: z.string().min(1).max(120),
    binding: explorationBindingSchema,
    draft: explorationDraftSchema,
  })
  .strict();
export const explorationReadingSchema = evolutionExplorationSelectionSchema
  .extend({
    selectedCaseId: z.string().min(1).max(240).optional(),
    comparisonScope: z.enum(['full', 'paired_subset']),
    comparisonScopeKey: z.string().max(16_000).optional(),
    viewport: z
      .object({
        x: z.number().finite().min(-1_000_000).max(1_000_000),
        y: z.number().finite().min(-1_000_000).max(1_000_000),
        zoom: z.number().finite().min(0.001).max(2.5),
        collapsed: z.array(z.string().max(1_200)).max(512),
      })
      .strict(),
    lineageCollapsed: z.boolean().optional(),
    draft: explorationDraftSchema,
  })
  .strict();

export type ExplorationReading = z.infer<typeof explorationReadingSchema>;
export type ExplorationBinding = z.infer<typeof explorationBindingSchema>;
export type ExplorationRequestContext = z.infer<typeof explorationRequestContextSchema>;
export const DEFAULT_EXPLORATION: ExplorationReading = {
  comparisonScope: 'full',
  viewport: { x: 0, y: 0, zoom: 1, collapsed: [] },
  draft: { text: '', intent: 'explore' },
};

/** Keep user-authored text and its original target; owner reading selections are independently reset. */
export function clearExplorationSelection(reading: ExplorationReading): ExplorationReading {
  return {
    viewport: reading.viewport,
    comparisonScope: 'full',
    draft: reading.draft,
    ...(reading.lineageCollapsed === undefined ? {} : { lineageCollapsed: reading.lineageCollapsed }),
  };
}
