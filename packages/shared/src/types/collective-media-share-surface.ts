import { z } from 'zod';
import { collectiveArtifactProjectionSchema } from './collective-artifact.js';
import { collectiveMediaSurfaceRefV1Schema } from './collective-media-surface.js';

const id = z.string().trim().min(1).max(256);
const positive = z.number().int().positive().safe();
/** A local picker freezes this complete request before any share effect, including its catalogue CAS. */
export const collectiveRetainedMediaShareSchema = z
  .object({
    contentRef: id,
    ownerRevision: positive,
    title: z.string().trim().min(1).max(200),
    sourceEventId: id,
    requestId: id,
    workId: id.optional(),
    expectedRevision: positive.optional(),
    expectedCustodyRevision: positive.optional(),
  })
  .strict();
export const collectiveRetainedMediaRegistrationRequestSchema = z
  .object({
    serviceInstanceId: id,
    collectiveId: id,
    connectionId: id,
    contentRef: id,
    sourceEventId: id,
    mediaType: z.enum(['image/png', 'video/mp4']),
  })
  .strict();
/** Read-only registration metadata. It grants neither owner access nor permission to publish. */
export const collectiveRetainedMediaRegistrationSchema = collectiveRetainedMediaRegistrationRequestSchema.extend({
  current: z.object({ revision: positive, custodyRevision: positive, workId: id.optional() }).strict().nullable(),
});
export type CollectiveRetainedMediaRegistrationRequest = z.infer<
  typeof collectiveRetainedMediaRegistrationRequestSchema
>;

export const collectiveMediaShareRefSchema = collectiveMediaSurfaceRefV1Schema.omit({
  artifactId: true,
  ownerRevision: true,
});
export type CollectiveMediaShareRef = z.infer<typeof collectiveMediaShareRefSchema>;
export const collectiveMediaShareOpenSchema = z
  .object({
    type: z.literal('collective:client-media-share'),
    ref: collectiveMediaShareRefSchema,
  })
  .strict();
export const collectiveMediaShareResultSchema = z
  .object({
    type: z.literal('collective:host-media-shared'),
    ref: collectiveMediaShareRefSchema,
    artifact: collectiveArtifactProjectionSchema.optional(),
  })
  .strict();
/** This DTO is local-Host only. It never crosses into the public Service or iframe. */
export const collectiveRetainedMediaPageSchema = z
  .object({
    items: z
      .object({
        contentRef: z.string().min(1).max(256),
        ownerRevision: z.number().int().positive().safe(),
        label: z.string().min(1).max(2048),
        mediaType: z.enum(['image/png', 'video/mp4']),
      })
      .strict()
      .array()
      .max(30),
    nextCursor: z.string().min(1).max(256).optional(),
  })
  .strict();
export type CollectiveRetainedMediaPage = z.infer<typeof collectiveRetainedMediaPageSchema>;
