import { z } from 'zod';
import {
  collectiveConnectionCoordinatesSchema,
  collectiveEventIdSchema,
  collectiveHumanIdSchema,
  collectiveLocationSchema,
} from './collective.js';
import { collectiveProjectArtifactReturnSchema } from './collective-project-artifact-return.js';

/** Public navigation coordinates only. A ref grants no content read or annotation authority. */
export const collectiveMediaSurfaceRefV1Schema = collectiveConnectionCoordinatesSchema
  .extend({
    v: z.literal(1),
    bridgeId: z.string().min(8).max(120),
    contextId: z.string().min(8).max(120),
    contextRevision: z.number().int().positive().safe(),
    humanId: collectiveHumanIdSchema,
    channelId: collectiveLocationSchema.shape.channelId,
    artifactId: z.string().trim().min(1).max(256),
    sourceEventId: collectiveEventIdSchema,
    ownerRevision: z.number().int().positive().safe(),
    projectReturn: collectiveProjectArtifactReturnSchema.optional(),
  })
  .strict();
export type CollectiveMediaSurfaceRefV1 = z.infer<typeof collectiveMediaSurfaceRefV1Schema>;
export const collectiveMediaSurfaceRefKey = (ref: CollectiveMediaSurfaceRefV1) =>
  JSON.stringify(collectiveMediaSurfaceRefV1Schema.parse(ref));

export const collectiveMediaSurfaceOpenSchema = z
  .object({
    type: z.literal('collective:client-media-surface'),
    ref: collectiveMediaSurfaceRefV1Schema,
  })
  .strict();
export const collectiveMediaSurfaceReturnSchema = z
  .object({
    type: z.literal('collective:host-media-return'),
    ref: collectiveMediaSurfaceRefV1Schema,
  })
  .strict();
