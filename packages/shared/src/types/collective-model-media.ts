import { z } from 'zod';
import { collectiveMessageAttachmentSchema } from './collective-message-content.js';
import {
  collectiveContextImageSelectionSchema,
  collectiveModelImageSchema,
  collectiveParticipationImageReadRequestSchema,
} from './collective-model-content.js';

const seconds = z.number().finite().nonnegative().max(86_400);
export const collectiveContextAttachmentSelectionSchema = collectiveContextImageSelectionSchema
  .extend({
    startSeconds: seconds.optional().describe('Audio/video window start, or the requested video frame time; default 0'),
    durationSeconds: z
      .number()
      .finite()
      .positive()
      .max(120)
      .optional()
      .describe('Audio window duration; default 30 seconds, maximum 120'),
    textOffset: z
      .number()
      .int()
      .nonnegative()
      .max(50 * 1024 * 1024)
      .optional()
      .describe('Continue a text file from the previous response nextOffset; default 0'),
  })
  .strict();
export type CollectiveContextAttachmentSelection = z.infer<typeof collectiveContextAttachmentSelectionSchema>;
export const collectiveParticipationMediaReadRequestSchema = collectiveParticipationImageReadRequestSchema
  .omit({ image: true })
  .extend({ attachment: collectiveContextAttachmentSelectionSchema })
  .strict();

const speechFields = {
  transcript: z.string().max(32_000),
  provider: z.string().trim().min(1).max(120),
  startSeconds: seconds,
  durationSeconds: z.number().finite().positive().max(120.1),
  totalDurationSeconds: z.number().finite().positive().optional(),
  truncated: z.boolean(),
};
export const collectiveModelMediaSchema = z
  .object({
    kind: z.literal('collective_model_media'),
    v: z.literal(1),
    attachmentId: collectiveMessageAttachmentSchema.shape.attachmentId,
    sourceDigest: collectiveMessageAttachmentSchema.shape.blobDigest,
    fileName: collectiveMessageAttachmentSchema.shape.fileName,
    mediaType: collectiveMessageAttachmentSchema.shape.mediaType,
    content: z.discriminatedUnion('type', [
      z
        .object({
          type: z.literal('text'),
          text: z.string().max(64_000),
          encoding: z.literal('utf-8'),
          truncated: z.boolean(),
          offset: z.number().int().nonnegative(),
          nextOffset: z.number().int().positive().optional(),
          totalCharacters: z.number().int().nonnegative(),
        })
        .strict(),
      z.object({ type: z.literal('audio'), ...speechFields }).strict(),
      z
        .object({
          type: z.literal('video'),
          atSeconds: seconds,
          durationSeconds: z.number().finite().positive().optional(),
          frame: collectiveModelImageSchema,
          audio: z.discriminatedUnion('status', [
            z.object({ status: z.literal('none') }).strict(),
            z.object({ status: z.literal('unavailable'), reason: z.literal('transcription_unavailable') }).strict(),
            z.object({ status: z.literal('transcribed'), ...speechFields }).strict(),
          ]),
        })
        .strict(),
      z
        .object({ type: z.literal('unavailable'), reason: z.enum(['unsupported_format', 'transcription_unavailable']) })
        .strict(),
    ]),
  })
  .strict()
  .superRefine((value, context) => {
    if (
      (value.content.type === 'audio' && !value.mediaType.startsWith('audio/')) ||
      (value.content.type === 'video' && !value.mediaType.startsWith('video/'))
    )
      context.addIssue({ code: 'custom', message: 'Model media kind must match its retained MIME type' });
    if (
      value.content.type === 'video' &&
      (value.content.frame.attachmentId !== value.attachmentId ||
        value.content.frame.sourceDigest !== value.sourceDigest)
    )
      context.addIssue({ code: 'custom', message: 'Video frame must name its original attachment' });
    if (new TextEncoder().encode(JSON.stringify(value)).length > 768 * 1024)
      context.addIssue({ code: 'custom', message: 'Model content exceeds the native response budget' });
  });
export type CollectiveModelMedia = z.infer<typeof collectiveModelMediaSchema>;
export const collectiveModelContentSchema = z.union([collectiveModelImageSchema, collectiveModelMediaSchema]);
export type CollectiveModelContent = z.infer<typeof collectiveModelContentSchema>;
