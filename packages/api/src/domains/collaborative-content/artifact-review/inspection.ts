import { z } from 'zod';
import type { MediaReviewPrincipal } from '../../video-studio/content-owner/published-media-access.js';
import { ArtifactReviewError } from './errors.js';
import type { ArtifactReviewService } from './service.js';

export const inspectArtifactReviewSchema = z
  .object({
    reviewId: z.string().min(1).max(128),
    view: z.enum(['overview', 'annotations', 'marks', 'history']).default('overview'),
    round: z.number().int().positive().optional(),
    expectedRevision: z.number().int().positive().optional(),
    cursor: z.number().int().min(0).max(1_000_000).default(0),
    afterHistoryRevision: z.number().int().min(0).default(0),
    maxChars: z.number().int().min(12000).max(12000).default(12000),
  })
  .strict();

/** JSON pointers retain exact bodies and authors while paging arbitrarily large comment threads and audit requests. */
export async function inspectArtifactReview(
  service: ArtifactReviewService,
  raw: unknown,
  principal: MediaReviewPrincipal,
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
  let nextHistoryRevision: number | null = null;
  if (input.view === 'overview') {
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
  if (input.cursor > records.length) throw new ArtifactReviewError('invalid_action');
  const base = {
    reviewId: view.review.reviewId,
    revision: view.review.revision,
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

function pageRecords<T extends { records: LeafRecord[]; nextCursor: number | null }>(
  base: T,
  records: LeafRecord[],
  cursor: number,
  maxChars: number,
): T {
  for (let index = cursor; index < records.length; index += 1) {
    const record = records[index];
    if (!record) break;
    const candidate = {
      ...base,
      records: [...base.records, record],
      nextCursor: index + 1 < records.length ? index + 1 : null,
    };
    if (JSON.stringify(candidate).length > maxChars) {
      if (!base.records.length) throw new ArtifactReviewError('limit_reached');
      base.nextCursor = index;
      break;
    }
    base.records.push(record);
    base.nextCursor = candidate.nextCursor;
  }
  return base;
}

interface LeafRecord {
  path: string;
  value: string | number | boolean | null;
}
function leafRecords(value: unknown, path = ''): LeafRecord[] {
  if (value === undefined) return [];
  if (value === null || typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean')
    return [{ path, value }];
  if (Array.isArray(value)) return value.flatMap((item, index) => leafRecords(item, `${path}/${index}`));
  if (typeof value === 'object')
    return Object.entries(value).flatMap(([key, item]) =>
      leafRecords(item, `${path}/${key.replaceAll('~', '~0').replaceAll('/', '~1')}`),
    );
  throw new ArtifactReviewError('invalid_action');
}
