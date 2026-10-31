import { createHash } from 'node:crypto';
import type { ArtifactReviewAction, ImmutableMedia } from '@cat-cafe/shared';
import { assertMediaAnchor } from './anchors.js';
import { ArtifactReviewError } from './errors.js';

export function mediaEditAnnotationId(annotationId: string, selectionId: string): string {
  return `media-edit-${createHash('sha256')
    .update(JSON.stringify([annotationId, selectionId]))
    .digest('hex')}`;
}

/** Validate the complete set before applying any annotation; the review store commits it as one action. */
export function mediaEditAnnotations(
  action: Extract<ArtifactReviewAction, { kind: 'request_media_edit' }>,
  media: ImmutableMedia,
): Extract<ArtifactReviewAction, { kind: 'annotate' }>[] {
  if (action.selections) {
    if (action.anchor || action.selections.length === 0 || action.selections.length > 12)
      throw new ArtifactReviewError('invalid_action');
    const ids = new Set<string>();
    return action.selections.map((item) => {
      if (ids.has(item.id)) throw new ArtifactReviewError('invalid_action');
      ids.add(item.id);
      assertMediaAnchor(item.selection, media);
      return {
        kind: 'annotate',
        annotationId: mediaEditAnnotationId(action.annotationId, item.id),
        anchor: item.selection,
        body: item.instruction ?? action.body,
      };
    });
  }
  const anchor =
    action.anchor ??
    (media.kind === 'image'
      ? { kind: 'image-region' as const, x: 0, y: 0, width: media.width, height: media.height }
      : {
          kind: 'video-range' as const,
          streamId: media.streamId,
          startTick: media.startTick,
          endTick: media.startTick + media.durationTicks,
        });
  assertMediaAnchor(anchor, media);
  return [{ kind: 'annotate', annotationId: action.annotationId, anchor, body: action.body }];
}
