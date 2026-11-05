import { z } from 'zod';
import { collectiveArtifactConstraintSchema } from './collective-artifact.js';

const id = z.string().trim().min(1).max(256);
const positive = z.number().int().positive().safe();
export const collectiveMediaCoordinatesSchema = z
  .object({ serviceInstanceId: id, collectiveId: id, connectionId: id })
  .strict();
export const collectiveMediaReadRequestSchema = collectiveMediaCoordinatesSchema
  .extend({
    artifactId: id,
    sourceEventId: id,
    ownerRevision: positive,
    range: z.string().max(256).optional(),
  })
  .strict();
export type CollectiveMediaReadRequest = z.infer<typeof collectiveMediaReadRequestSchema>;
export const collectiveMediaOperationSchema = z
  .object({
    relayRef: id,
    constraint: collectiveArtifactConstraintSchema,
    range: z.string().max(256).optional(),
    expiresAt: positive,
  })
  .strict()
  .refine(
    (op) =>
      op.constraint.action === 'read' &&
      !op.constraint.agent &&
      !op.constraint.reviewReply &&
      !op.constraint.mediaReviewReply,
  );
export type CollectiveArtifactMediaOperation = z.infer<typeof collectiveMediaOperationSchema>;
export const collectiveMediaResponseCoordinatesSchema = collectiveMediaCoordinatesSchema
  .extend({ relayRef: id })
  .strict();
export const collectiveMediaDescriptorSchema = z
  .object({
    contentRef: id,
    ownerRevision: positive,
    blobDigest: z.string().regex(/^sha256:[a-f0-9]{64}$/),
    ownerReceiptRef: id,
    mediaType: z.enum(['image/png', 'video/mp4']),
    byteLength: positive,
    status: z.union([z.literal(200), z.literal(206), z.literal(416)]),
    start: z.number().int().nonnegative().safe().optional(),
    end: z.number().int().nonnegative().safe().optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (
      value.status === 206
        ? value.start === undefined ||
          value.end === undefined ||
          value.start > value.end ||
          value.end >= value.byteLength
        : value.start !== undefined || value.end !== undefined
    )
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Invalid exact media byte range' });
  });
export type CollectiveMediaDescriptor = z.infer<typeof collectiveMediaDescriptorSchema>;
export const collectiveMediaErrorSchema = z.enum([
  'access_denied',
  'conflict',
  'owner_unavailable',
  'invalid_request',
  'unsupported_operation',
  'unknown',
]);
export const collectiveMediaDescriptorHeader = 'x-collective-media';
export const collectiveMediaErrorHeader = 'x-collective-media-error';
export const collectiveMediaBufferBytes = 64 * 1024;
export const collectiveMediaRelaySlots = 32;

type MediaResponse = Pick<CollectiveMediaDescriptor, 'status' | 'start' | 'end' | 'byteLength'> & { mediaType: string };
export function collectiveMediaResponseLength(value: MediaResponse): number {
  if (value.status === 416) return 0;
  if (value.status === 206 && value.start !== undefined && value.end !== undefined) return value.end - value.start + 1;
  return value.byteLength;
}

/** Shared by the outbound Service relay and the local authenticated Host proxy. */
export function collectiveMediaResponseHeaders(value: MediaResponse): Record<string, string> {
  const headers: Record<string, string> = {
    'content-type': value.mediaType,
    'cache-control': 'private, no-store',
    'x-content-type-options': 'nosniff',
    'accept-ranges': 'bytes',
    'content-length': String(collectiveMediaResponseLength(value)),
  };
  if (value.status === 206) headers['content-range'] = `bytes ${value.start}-${value.end}/${value.byteLength}`;
  if (value.status === 416) headers['content-range'] = `bytes */${value.byteLength}`;
  return headers;
}
