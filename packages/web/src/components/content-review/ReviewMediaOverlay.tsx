import type { ArtifactReviewAnchor, ImmutableMedia } from '@cat-cafe/shared';
import { ReviewCanvasAnnotations } from './ReviewCanvasAnnotations';
import type { ReviewCanvasMode } from './ReviewCanvasToolbar';
import { ReviewMarkupLayer } from './ReviewMarkupLayer';
import { ReviewSavedMarkupLayer } from './ReviewSavedMarkupLayer';
import type { ReviewMarkupFrame } from './review-markup-draft';
import type { useReviewMediaSelection } from './useReviewMediaSelection';

export function ReviewMediaOverlay({
  media,
  frame,
  marks,
  annotations,
  activeAnnotationId,
  seconds,
  mode,
  selected,
  selection,
  onAnnotationActive,
  markup,
}: {
  media: ImmutableMedia;
  frame: ReviewMarkupFrame | null | undefined;
  marks: Parameters<typeof ReviewSavedMarkupLayer>[0]['marks'];
  annotations: Parameters<typeof ReviewCanvasAnnotations>[0]['annotations'];
  activeAnnotationId: string | null;
  seconds: number;
  mode: ReviewCanvasMode;
  selected: ArtifactReviewAnchor | null;
  selection: ReturnType<typeof useReviewMediaSelection>;
  onAnnotationActive: (id: string) => void;
  markup: Parameters<typeof ReviewMarkupLayer>[0] | null;
}) {
  const anchor = selection.drag ?? selected;
  const region = anchor?.kind === 'image-region' ? anchor : anchor?.kind === 'video-range' ? anchor.frameRegion : null;
  const point = anchor?.kind === 'image-point' ? anchor : anchor?.kind === 'video-range' ? anchor.framePoint : null;
  return (
    <>
      <ReviewSavedMarkupLayer marks={marks} media={media} frame={frame ?? null} />
      <svg
        viewBox={`0 0 ${media.width} ${media.height}`}
        className={`absolute inset-0 h-full w-full ${selection.selectionActive ? 'touch-none cursor-crosshair' : 'pointer-events-none'}`}
        {...selection.handlers}
        aria-label="图片或视频上的批注"
      >
        <ReviewCanvasAnnotations
          annotations={annotations}
          media={media}
          activeId={activeAnnotationId}
          seconds={seconds}
          interactive={mode !== 'markup' && (!selection.selecting || mode === 'comment')}
          onActive={onAnnotationActive}
        />
        {region ? (
          <rect
            x={region.x}
            y={region.y}
            width={region.width}
            height={region.height}
            fill="var(--cafe-accent)"
            fillOpacity={0.16}
            stroke="var(--cafe-accent)"
            strokeDasharray="6 4"
            vectorEffect="non-scaling-stroke"
          />
        ) : null}
        {point ? (
          <circle cx={point.x} cy={point.y} r={Math.max(5, media.width / 100)} fill="var(--cafe-accent)" />
        ) : null}
      </svg>
      {markup ? <ReviewMarkupLayer {...markup} /> : null}
    </>
  );
}
