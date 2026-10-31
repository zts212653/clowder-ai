import type { ContentModificationRecord } from '@cat-cafe/shared';
import { ArtifactReviewError } from '../../artifact-review/errors.js';
import { mediaEditAnnotationId } from '../../artifact-review/media-edit-selections.js';
import type { ArtifactReviewStore } from '../../artifact-review/store.js';

export function modificationMediaAnnotationNamespace(requestId: string): string {
  return `modify-${requestId.slice('f309-modification-'.length)}`;
}

/** Join only this request's named selections; retained annotations may predate the request. */
export function mediaSelectionAnnotations(store: ArtifactReviewStore, record: ContentModificationRecord) {
  const binding = record.progress.review;
  const selections = record.payload.intent.selections;
  if (record.progress.prepared?.kind !== 'media' || !binding || !selections) return undefined;
  const round = store.get(binding.reviewId)?.rounds.find((item) => item.number === binding.round);
  if (!round) throw new ArtifactReviewError('not_found');
  return selections.map((selection) => {
    const annotationId = mediaEditAnnotationId(modificationMediaAnnotationNamespace(record.requestId), selection.id);
    if (!round.annotations.some((item) => item.id === annotationId)) throw new ArtifactReviewError('invalid_action');
    return { selectionId: selection.id, annotationId };
  });
}
