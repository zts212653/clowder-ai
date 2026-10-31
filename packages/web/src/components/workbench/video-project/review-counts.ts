import type { VideoProjectDocumentV1, VideoProjectFrozenInput } from '@cat-cafe/shared';

export function projectReviewCounts(
  document: VideoProjectDocumentV1,
  input: VideoProjectFrozenInput,
  frozenDocument = document,
) {
  const latest = new Map<string, 'pass' | 'changes-requested'>();
  for (const fact of document.selfReviews ?? []) {
    if (
      fact.input.contentRef !== input.contentRef ||
      fact.input.ownerRevision !== input.ownerRevision ||
      fact.input.blobDigest !== input.blobDigest
    )
      continue;
    for (const id of fact.segmentIds) latest.set(id, fact.conclusion);
  }
  const valid = new Set(frozenDocument.timeline.segments.map((segment) => segment.id));
  return {
    reviewed: [...latest].filter(([id, conclusion]) => valid.has(id) && conclusion === 'pass').length,
    hasRecords: latest.size > 0,
  };
}
