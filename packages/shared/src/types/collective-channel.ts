import { z } from 'zod';
import { collectiveCoordinatesSchema, collectiveHumanActorSchema, collectiveIdSchema } from './collective.js';

export const COLLECTIVE_CHANNEL_NAME_MAX = 40;
export const COLLECTIVE_CHANNEL_CREATE_LIMIT = 100;

export type CollectiveChannelNameIssue = 'empty' | 'too_long' | 'invalid_characters';

export function normalizeCollectiveChannelName(value: string): string {
  return value
    .normalize('NFKC')
    .trim()
    .replace(/[ \t]+/gu, ' ');
}

export function collectiveChannelNameIssue(value: string): CollectiveChannelNameIssue | undefined {
  const normalized = normalizeCollectiveChannelName(value);
  if (!normalized) return 'empty';
  if (Array.from(normalized).length > COLLECTIVE_CHANNEL_NAME_MAX) return 'too_long';
  if (Array.from(normalized).some(isForbiddenChannelNameCharacter)) return 'invalid_characters';
  return undefined;
}

function isForbiddenChannelNameCharacter(character: string): boolean {
  const codePoint = character.codePointAt(0);
  return (
    codePoint !== undefined &&
    (codePoint <= 0x1f || codePoint === 0x7f || character === '#' || character === '/' || character === '\\')
  );
}

export function collectiveChannelNameKey(value: string): string {
  return normalizeCollectiveChannelName(value).toLowerCase();
}

export const collectiveChannelNameSchema = z
  .string()
  .max(200)
  .transform(normalizeCollectiveChannelName)
  .superRefine((value, context) => {
    const issue = collectiveChannelNameIssue(value);
    if (issue) context.addIssue({ code: z.ZodIssueCode.custom, message: issue });
  });

/** Existing public coordinates remain readable even when they predate the managed-name policy. */
export const collectiveChannelIdSchema = z.string().trim().min(1).max(160);

export const collectiveChannelProjectionSchema = collectiveCoordinatesSchema
  .extend({
    channelId: collectiveChannelIdSchema,
    visibility: z.literal('public'),
    createdBy: collectiveHumanActorSchema.omit({ kind: true }).strict(),
    createdAt: z.string().datetime(),
    revision: z.number().int().positive(),
  })
  .strict();

export const collectiveChannelListSchema = collectiveCoordinatesSchema
  .extend({ channels: z.array(collectiveChannelProjectionSchema) })
  .strict();

export const collectiveChannelCreateRequestSchema = z
  .object({
    collectiveId: collectiveIdSchema,
    name: collectiveChannelNameSchema,
    clientOperationId: z.string().trim().min(8).max(160),
  })
  .strict();

export const collectiveChannelCreateResponseSchema = z
  .object({
    status: z.enum(['created', 'replayed', 'existing']),
    channel: collectiveChannelProjectionSchema,
  })
  .strict();

export type CollectiveChannelProjection = z.infer<typeof collectiveChannelProjectionSchema>;
export type CollectiveChannelList = z.infer<typeof collectiveChannelListSchema>;
export type CollectiveChannelCreateRequest = z.infer<typeof collectiveChannelCreateRequestSchema>;
export type CollectiveChannelCreateResponse = z.infer<typeof collectiveChannelCreateResponseSchema>;
