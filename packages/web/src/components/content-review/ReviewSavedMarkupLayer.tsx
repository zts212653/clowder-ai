import type { ArtifactReviewVisualMark, ImmutableMedia } from '@cat-cafe/shared';
import { MarkupShape } from './ReviewMarkupShapes';
import type { ReviewMarkupFrame } from './review-markup-draft';

export function ReviewSavedMarkupLayer({
  marks,
  media,
  frame,
}: {
  marks: ArtifactReviewVisualMark[];
  media: ImmutableMedia;
  frame: ReviewMarkupFrame | null;
}) {
  return (
    <svg
      viewBox={`0 0 ${media.width} ${media.height}`}
      className="pointer-events-none absolute inset-0 h-full w-full"
      aria-label="已保存的标记"
      data-testid="review-saved-markup-layer"
    >
      {marks
        .filter(
          (mark) =>
            mark.state === 'active' &&
            (!mark.drawing.frame ||
              (frame && mark.drawing.frame.streamId === frame.streamId && mark.drawing.frame.tick === frame.tick)),
        )
        .map((mark, index) => (
          <MarkupShape
            key={mark.drawing.id}
            mark={mark.drawing}
            active={false}
            saved
            label={`${mark.author.actorId} 保存的标记 ${index + 1}`}
          />
        ))}
    </svg>
  );
}
