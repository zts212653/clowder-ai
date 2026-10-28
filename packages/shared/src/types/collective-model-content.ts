import { z } from 'zod';
import { collectiveConnectionCoordinatesSchema } from './collective.js';
import { collectiveMessageAttachmentSchema } from './collective-message-content.js';

export const collectiveContextImageSelectionSchema = z
  .object({
    eventId: z.string().min(1).max(160).describe('Published eventId from the current Channel context'),
    attachmentId: collectiveMessageAttachmentSchema.shape.attachmentId.describe('attachmentId on that event'),
  })
  .strict();
export const collectiveParticipationImageReadRequestSchema = collectiveConnectionCoordinatesSchema
  .extend({
    eventId: z.string().min(1).max(160),
    catId: z.string().min(1).max(120),
    participationRevision: z.number().int().positive(),
    image: collectiveContextImageSelectionSchema,
  })
  .strict();

/** Preparing a catalogue sticker uses the exact named public source, never a Human browser session. */
export const collectiveParticipationStickerPrepareRequestSchema = collectiveParticipationImageReadRequestSchema
  .omit({ image: true })
  .extend({
    stickerId: z.string().min(1).max(80),
    clientUploadId: z.string().trim().min(1).max(200),
  })
  .strict();

/** A transient model response, never a Channel event or an attachment owner reference.
 * The existing native bridge has 1 MiB frames; base64 and metadata must fit together. */
export const COLLECTIVE_MODEL_IMAGE_MAX_BYTES = 512 * 1024;
export const collectiveModelImageSchema = z
  .object({
    kind: z.literal('collective_model_image'),
    v: z.literal(1),
    attachmentId: collectiveMessageAttachmentSchema.shape.attachmentId,
    sourceDigest: collectiveMessageAttachmentSchema.shape.blobDigest,
    mediaType: z.enum(['image/png', 'image/jpeg', 'image/webp']),
    dataBase64: z
      .string()
      .min(4)
      .max(4 * Math.ceil(COLLECTIVE_MODEL_IMAGE_MAX_BYTES / 3))
      .regex(/^[A-Za-z0-9+/]+={0,2}$/u)
      .refine((value) => value.length % 4 === 0)
      .refine(
        (value) =>
          (value.length / 4) * 3 - (value.endsWith('==') ? 2 : value.endsWith('=') ? 1 : 0) <=
          COLLECTIVE_MODEL_IMAGE_MAX_BYTES,
      ),
    width: z.number().int().positive().max(1536),
    height: z.number().int().positive().max(1536),
    originalWidth: z.number().int().positive(),
    originalHeight: z.number().int().positive(),
    transformed: z.boolean(),
  })
  .strict();
export type CollectiveModelImage = z.infer<typeof collectiveModelImageSchema>;
