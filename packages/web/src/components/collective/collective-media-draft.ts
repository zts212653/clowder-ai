import {
  artifactReviewAnchorSchema,
  type CollectiveMediaSurfaceRefV1,
  collectiveMediaReviewCommandSchema,
} from '@cat-cafe/shared';
import { z } from 'zod';

export const mediaDraftSchema = z
  .object({
    body: z.string().max(8000),
    anchor: artifactReviewAnchorSchema.nullable(),
    pending: z
      .object({ operationId: z.string().uuid(), command: collectiveMediaReviewCommandSchema })
      .strict()
      .optional(),
  })
  .strict();
export type MediaDraft = z.infer<typeof mediaDraftSchema>;
export const emptyMediaDraft = (): MediaDraft => ({ body: '', anchor: null });
export const mediaDraftKey = (ref: CollectiveMediaSurfaceRefV1) =>
  `collective-media-draft:${JSON.stringify([ref.serviceInstanceId, ref.collectiveId, ref.humanId, ref.artifactId, ref.sourceEventId, ref.ownerRevision])}`;
export function readMediaDraft(key: string): MediaDraft {
  const saved = localStorage.getItem(key);
  return saved ? mediaDraftSchema.parse(JSON.parse(saved)) : emptyMediaDraft();
}
/** Settle only this exact pending command. A newer draft/command in this tab or another tab survives. */
export function settleMediaDraft(
  key: string,
  pending: NonNullable<MediaDraft['pending']>,
  result: 'committed' | 'conflict' = 'committed',
) {
  const current = readMediaDraft(key);
  const expected = mediaDraftSchema.parse({ body: '', anchor: null, pending }).pending;
  if (JSON.stringify(current.pending) !== JSON.stringify(expected)) return current;
  const action = pending.command.action;
  const sameAnnotation =
    result === 'committed' &&
    action.kind === 'annotate' &&
    current.body.trim() === action.body &&
    JSON.stringify(current.anchor) === JSON.stringify(action.anchor);
  const next = { ...current, ...(sameAnnotation ? { body: '', anchor: null } : {}) };
  delete next.pending;
  localStorage.setItem(key, JSON.stringify(next));
  return next;
}
