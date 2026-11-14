import { z } from 'zod';
import { messageMediaItemSelectorSchema } from './message-media-item-selector.js';
import {
  videoProjectActorSchema,
  videoProjectAssetVersionSchema,
  videoProjectDigestSchema,
  videoProjectTextSchema,
} from './video-project-primitives.js';
import { workReferenceSchema } from './work-reference.js';

const text = videoProjectTextSchema;
const id = text(256);
const positive = z.number().int().positive().safe();
const revision = z.number().int().nonnegative().safe();

/** Uploaded originals are owner-named files; the browser never names a host path. */
export const WORK_COVER_UPLOAD_URL = /^\/uploads\/work-cover-[0-9]+-[a-f0-9]{8}\.(png|jpg|webp)$/;

/**
 * Where a person or cat found the picture. The owner resolves every pick to one exact file
 * version; a URL, a name or a directory never stands in for that resolution.
 */
export const workCoverPickSchema = z.discriminatedUnion('kind', [
  /** An asset registered in a fixed version's video context of the same work. */
  z
    .object({ kind: z.literal('work-asset'), ownerRevision: positive, metadataRevision: positive, assetId: id })
    .strict(),
  /** One media item of a persisted conversation message, checked against that message. */
  z
    .object({
      kind: z.literal('thread-image'),
      threadId: id,
      messageId: id,
      messageRevision: z.string().max(64).regex(/^\d+$/),
      item: messageMediaItemSelectorSchema,
      expectedUrl: text(2048),
    })
    .strict(),
  /** A picture the person just uploaded from this computer. */
  z.object({ kind: z.literal('upload'), uploadUrl: z.string().regex(WORK_COVER_UPLOAD_URL) }).strict(),
]);
export type WorkCoverPick = z.infer<typeof workCoverPickSchema>;

export const workCoverChoiceSchema = z.discriminatedUnion('mode', [
  z.object({ mode: z.literal('image'), pick: workCoverPickSchema }).strict(),
  /** Clear: the card goes back to a real frame of this video. */
  z.object({ mode: z.literal('frame') }).strict(),
  /** Undo: re-adopt the exact file an earlier revision of this same version recorded. */
  z.object({ mode: z.literal('restore'), coverRevision: positive }).strict(),
]);
export type WorkCoverChoice = z.infer<typeof workCoverChoiceSchema>;

/** Changing a cover never changes video bytes or the film's ownerRevision; it has its own CAS. */
export const setWorkCoverSchema = z
  .object({
    action: z.literal('set-cover'),
    reference: workReferenceSchema,
    operationId: id,
    expectedCoverRevision: revision,
    choice: workCoverChoiceSchema,
  })
  .strict();
export type SetWorkCover = z.infer<typeof setWorkCoverSchema>;

export const readWorkCoverSchema = z
  .object({ action: z.literal('read-cover'), reference: workReferenceSchema, coverRevision: positive.optional() })
  .strict();

/** A new version keeps the previous version's cover as frozen at submit time unless told otherwise. */
export const workSubmitCoverSchema = z.discriminatedUnion('mode', [
  z.object({ mode: z.literal('inherit') }).strict(),
  z.object({ mode: z.literal('frame') }).strict(),
  z.object({ mode: z.literal('image'), pick: workCoverPickSchema }).strict(),
]);
export type WorkSubmitCover = z.infer<typeof workSubmitCoverSchema>;

export const workCoverOriginSchema = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal('work-asset'),
      reference: workReferenceSchema,
      metadataRevision: positive,
      assetId: id,
      assetName: text(1000),
      assetKind: text(256),
    })
    .strict(),
  z
    .object({
      kind: z.literal('thread-image'),
      threadId: id,
      messageId: id,
      messageRevision: z.string().max(64).regex(/^\d+$/),
      item: messageMediaItemSelectorSchema,
      url: text(2048),
    })
    .strict(),
  z.object({ kind: z.literal('upload'), url: z.string().regex(WORK_COVER_UPLOAD_URL) }).strict(),
]);
export type WorkCoverOrigin = z.infer<typeof workCoverOriginSchema>;

export const workCoverImageSchema = z
  .object({ name: text(1000), version: videoProjectAssetVersionSchema, origin: workCoverOriginSchema })
  .strict();
export type WorkCoverImage = z.infer<typeof workCoverImageSchema>;

export const workCoverBasisSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('chosen') }).strict(),
  z.object({ kind: z.literal('cleared') }).strict(),
  z.object({ kind: z.literal('restored'), coverRevision: positive }).strict(),
  /** Frozen when the new version was submitted; later edits of the source version do not reach it. */
  z.object({ kind: z.literal('inherited'), fromOwnerRevision: positive, fromCoverRevision: positive }).strict(),
  z.object({ kind: z.literal('submitted') }).strict(),
]);
export type WorkCoverBasis = z.infer<typeof workCoverBasisSchema>;

export const workCoverRecordSchema = z
  .object({
    reference: workReferenceSchema,
    coverRevision: positive,
    ownerUserId: id,
    operationId: id,
    requestDigest: videoProjectDigestSchema,
    actor: videoProjectActorSchema,
    recordedAt: z.string().datetime(),
    image: workCoverImageSchema.nullable(),
    basis: workCoverBasisSchema,
  })
  .strict();
export type WorkCoverRecord = z.infer<typeof workCoverRecordSchema>;

/**
 * none: never chosen; frame: explicitly cleared; image: readable now; unavailable: chosen but the
 * picture cannot be read right now. Unavailable keeps the choice and never substitutes another image.
 */
export const workCoverStateSchema = z.enum(['none', 'frame', 'image', 'unavailable']);
export type WorkCoverState = z.infer<typeof workCoverStateSchema>;

export const workCoverViewSchema = z
  .object({
    reference: workReferenceSchema,
    coverRevision: revision,
    state: workCoverStateSchema,
    image: z
      .object({
        name: text(1000),
        mediaType: text(256),
        sha256: videoProjectDigestSchema,
        origin: workCoverOriginSchema,
        url: text(4096),
      })
      .strict()
      .optional(),
    basis: workCoverBasisSchema.optional(),
    actor: videoProjectActorSchema.optional(),
    recordedAt: z.string().datetime().optional(),
  })
  .strict();
export type WorkCoverView = z.infer<typeof workCoverViewSchema>;
