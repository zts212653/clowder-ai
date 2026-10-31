import type { ContentModificationRecord } from '@cat-cafe/shared';

/**
 * Which review a modification request belongs to, read from what the owner holds about the request and nothing else.
 * The same published version can be a round of several reviews (sibling Tasks on one work), so a matching asset never
 * says whose round it is.
 *
 * Three pieces of evidence can name the review: the committed binding (`progress.review`, written when the request was
 * bound, and the only one a request without a context has: its Task and review are created at bind time), the
 * request-time media context, and the review of a Task-round source. They agree for every request the owner binds;
 * if they ever do not, the answer is `conflict`, not either of them. A workspace file's review and an experiment's
 * review are other families of review and say nothing here.
 */
export type ModificationReviewBinding =
  | { readonly state: 'bound'; readonly reviewId: string }
  | { readonly state: 'unbound' }
  | { readonly state: 'conflict' };

export function modificationReviewBinding(record: ContentModificationRecord): ModificationReviewBinding {
  const named = new Set<string>();
  const committed = record.progress.review?.reviewId;
  if (committed) named.add(committed);
  const context = record.payload.taskContext;
  if (context && context.kind !== 'text' && context.reviewId) named.add(context.reviewId);
  const source = record.payload.source;
  if (source.kind === 'artifact-review') named.add(source.reviewId);
  if (named.size === 0) return { state: 'unbound' };
  if (named.size > 1) return { state: 'conflict' };
  const [reviewId] = named;
  return reviewId === undefined ? { state: 'unbound' } : { state: 'bound', reviewId };
}
