import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { MediaReviewPrincipal } from '../../video-studio/content-owner/published-media-access.js';
import { type LeafRecord, leafRecords, pageRecords } from '../inspection-records.js';
import type { ModificationSourceDiscussions } from '../modification/source-discussions.js';
import { ArtifactReviewError } from './errors.js';
import type { ArtifactReviewService } from './service.js';

export const inspectArtifactReviewSchema = z
  .object({
    reviewId: z.string().min(1).max(128),
    sourceMessageId: z.string().min(1).max(256).optional(),
    attachmentId: z.string().min(1).max(128).optional(),
    view: z.enum(['overview', 'annotations', 'marks', 'history']).default('overview'),
    round: z.number().int().positive().optional(),
    expectedRevision: z.number().int().positive().optional(),
    expectedSourceSnapshot: z
      .string()
      .regex(/^sha256:[a-f0-9]{64}$/)
      .optional(),
    cursor: z.number().int().min(0).max(1_000_000).default(0),
    afterHistoryRevision: z.number().int().min(0).default(0),
    maxChars: z.number().int().min(12000).max(12000).default(12000),
  })
  .strict();

export type ArtifactReviewInspection = z.infer<typeof inspectArtifactReviewSchema>;

/** JSON pointers retain exact bodies and authors while paging arbitrarily large comment threads and audit requests. */
export async function inspectArtifactReview(
  service: ArtifactReviewService,
  raw: unknown,
  principal: MediaReviewPrincipal,
  sourceDiscussions?: Pick<ModificationSourceDiscussions, 'forReview'>,
) {
  const input = inspectArtifactReviewSchema.parse(raw);
  const view = await service.read(input.reviewId, principal);
  if (
    (input.cursor > 0 && !input.expectedRevision) ||
    (input.expectedRevision && input.expectedRevision !== view.review.revision)
  )
    throw new ArtifactReviewError('revision_conflict');
  const round = input.round
    ? view.review.rounds.find((item) => item.number === input.round)
    : view.review.rounds.at(-1);
  if (!round) throw new ArtifactReviewError('not_found');
  let value: unknown;
  let sourceSnapshot: string | undefined;
  let nextHistoryRevision: number | null = null;
  if (input.view === 'overview') {
    const originals = await sourceDiscussions?.forReview(input.reviewId, principal, view.review.revision);
    if (originals?.length || (originals && input.expectedSourceSnapshot))
      sourceSnapshot = `sha256:${createHash('sha256').update(JSON.stringify(originals)).digest('hex')}`;
    if (
      (input.cursor > 0 && sourceSnapshot && !input.expectedSourceSnapshot) ||
      (input.expectedSourceSnapshot && input.expectedSourceSnapshot !== sourceSnapshot)
    )
      throw new ArtifactReviewError('revision_conflict');
    value = {
      title: view.review.title,
      task: view.review.task,
      versions: view.review.rounds.map((item) => ({
        number: item.number,
        state: item.state,
        ownerRevision: item.asset.ownerRevision,
        openedAt: item.openedAt,
      })),
      currentRound: { ...round, annotations: undefined, visualMarks: undefined },
      annotationCount: round.annotations.length,
      visualMarkCount: round.visualMarks?.filter((mark) => mark.state === 'active').length ?? 0,
      sourceDiscussions: originals,
    };
  } else if (input.view === 'annotations') value = round.annotations;
  else if (input.view === 'marks') value = round.visualMarks ?? [];
  else {
    const history = await service.history(input.reviewId, principal, input.afterHistoryRevision, 1);
    if ((history.entries[0]?.receipt.revision ?? 0) > view.review.revision)
      throw new ArtifactReviewError('revision_conflict');
    value = history.entries[0] ?? null;
    nextHistoryRevision = history.nextCursor;
  }
  const records = leafRecords(value);
  if (input.view !== 'overview' && input.expectedSourceSnapshot) throw new ArtifactReviewError('invalid_action');
  if (input.cursor > records.length) throw new ArtifactReviewError('invalid_action');
  const base = {
    reviewId: view.review.reviewId,
    revision: view.review.revision,
    ...(view.modificationRequest ? { modificationRequest: view.modificationRequest } : {}),
    ...(sourceSnapshot ? { sourceSnapshot } : {}),
    round: round.number,
    section: input.view,
    authority: view.authority,
    continuation: view.continuation,
    trust: 'untrusted_review_data' as const,
    records: [] as LeafRecord[],
    nextCursor: null as number | null,
    nextHistoryRevision,
  };
  return pageRecords(base, records, input.cursor, input.maxChars);
}
