import { z } from 'zod';
import { videoProjectJsonSchema } from './video-project-json.js';

export const videoProjectIdSchema = z
  .string()
  .min(1)
  .max(256)
  .refine((value) => value.trim().length > 0);
export const videoProjectTimestampSchema = z.string().max(64).datetime();
export const videoProjectDigestSchema = z.string().regex(/^sha256:[a-f0-9]{64}$/);
export const videoProjectPositiveSchema = z.number().int().positive().safe();
export const videoProjectTickSchema = z.number().int().nonnegative().safe();
/** Validate user text without changing spelling or whitespace. */
export const videoProjectTextSchema = (max: number) =>
  z
    .string()
    .min(1)
    .max(max)
    .refine((value) => value.trim().length > 0, 'Text must be nonblank');

export const videoProjectActorSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('human'), actorId: videoProjectIdSchema }).strict(),
  z.object({ kind: z.literal('cat'), actorId: videoProjectIdSchema }).strict(),
]);
export type VideoProjectActor = z.infer<typeof videoProjectActorSchema>;

export const videoProjectOriginSchema = z
  .object({
    kind: z.enum(['imported', 'created']),
    actor: videoProjectActorSchema.nullable(),
    at: videoProjectTimestampSchema,
    refs: z.array(videoProjectIdSchema).max(1000),
    converter: z.object({ id: videoProjectIdSchema, version: videoProjectIdSchema }).strict().optional(),
    sources: z
      .array(z.object({ ref: videoProjectTextSchema(2048), digest: videoProjectDigestSchema }).strict())
      .max(10000)
      .optional(),
  })
  .strict();
export type VideoProjectOrigin = z.infer<typeof videoProjectOriginSchema>;

export * from './video-project-json.js';
export const videoProjectExtensionSchema = z
  .object({
    namespace: videoProjectIdSchema,
    schemaVersion: videoProjectPositiveSchema,
    payload: videoProjectJsonSchema,
  })
  .strict();
export type VideoProjectExtension = z.infer<typeof videoProjectExtensionSchema>;

export const videoProjectLocatorSchema = z
  .object({
    kind: z.literal('workspace'),
    rootId: videoProjectIdSchema,
    path: videoProjectTextSchema(2048).refine(
      (path) =>
        !path.includes(':') &&
        !path.includes('\\') &&
        [...path].every((character) => character.charCodeAt(0) >= 32 && character.charCodeAt(0) !== 127) &&
        path.split('/').every((part) => part !== '' && part !== '.' && part !== '..'),
      'Locator must be a safe relative path within a registered root',
    ),
  })
  .strict();

export const videoProjectAssetVersionSchema = z
  .object({
    id: videoProjectIdSchema,
    mediaType: videoProjectTextSchema(256),
    byteLength: videoProjectTickSchema,
    sha256: videoProjectDigestSchema,
    locator: videoProjectLocatorSchema,
    recordedAt: videoProjectTimestampSchema,
    origin: videoProjectOriginSchema,
    width: videoProjectPositiveSchema.optional(),
    height: videoProjectPositiveSchema.optional(),
    rotation: z.union([z.literal(0), z.literal(90), z.literal(180), z.literal(270)]).optional(),
    durationTicks: videoProjectPositiveSchema.optional(),
  })
  .strict();
export type VideoProjectAssetVersion = z.infer<typeof videoProjectAssetVersionSchema>;
export const videoProjectAssetSchema = z
  .object({
    id: videoProjectIdSchema,
    name: videoProjectTextSchema(1000),
    kind: videoProjectTextSchema(256),
    versions: z.array(videoProjectAssetVersionSchema).min(1).max(10000),
  })
  .strict();
