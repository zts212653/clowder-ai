'use client';
import type { ArtifactReviewAnnotation, ReviewedMediaAsset } from '@cat-cafe/shared';
import { anchorBounds, tickToBrowserTime } from './review-geometry';

export function ReviewCanvasAnnotations({
  annotations,
  media,
  activeId,
  seconds,
  interactive = true,
  onActive,
}: {
  annotations: ArtifactReviewAnnotation[];
  media: ReviewedMediaAsset['media'];
  activeId: string | null;
  seconds: number;
  interactive?: boolean;
  onActive: (annotationId: string) => void;
}) {
  return (
    <>
      {annotations.map((annotation, index) => (
        <AnnotationMark
          key={annotation.id}
          annotation={annotation}
          index={index}
          media={media}
          activeId={activeId}
          seconds={seconds}
          interactive={interactive}
          onActive={onActive}
        />
      ))}
    </>
  );
}

function AnnotationMark({
  annotation,
  index,
  media,
  activeId,
  seconds,
  interactive,
  onActive,
}: {
  annotation: ArtifactReviewAnnotation;
  index: number;
  media: ReviewedMediaAsset['media'];
  activeId: string | null;
  seconds: number;
  interactive: boolean;
  onActive: (annotationId: string) => void;
}) {
  const anchor = annotation.anchor;
  const box = anchorBounds(anchor);
  const isPoint = anchor.kind === 'image-point' || (anchor.kind === 'video-range' && !!anchor.framePoint);
  const visible =
    !!box &&
    !(
      media.kind === 'video' &&
      anchor.kind === 'video-range' &&
      (seconds < tickToBrowserTime(anchor.startTick, media) || seconds >= tickToBrowserTime(anchor.endTick, media))
    );
  if (!box || !visible) return null;
  const graphic = (
    <>
      {isPoint ? (
        <circle
          cx={box.x}
          cy={box.y}
          r={Math.max(8, media.width / 65)}
          fill="var(--cafe-accent)"
          stroke="var(--cafe-surface)"
          strokeWidth={2}
          vectorEffect="non-scaling-stroke"
        />
      ) : (
        <rect
          x={box.x}
          y={box.y}
          width={box.width}
          height={box.height}
          fill="var(--cafe-accent)"
          fillOpacity={0.07}
          stroke="var(--cafe-accent)"
          strokeWidth={activeId === annotation.id ? 3 : 1.5}
          vectorEffect="non-scaling-stroke"
        />
      )}
      <text
        x={isPoint ? box.x : box.x + 4}
        y={isPoint ? box.y : box.y + 17}
        textAnchor={isPoint ? 'middle' : undefined}
        dominantBaseline={isPoint ? 'central' : undefined}
        fill={isPoint ? 'var(--cafe-surface)' : 'var(--cafe-accent)'}
        fontSize={Math.max(12, media.width / 65)}
      >
        {index + 1}
      </text>
    </>
  );
  const attributes = {
    'data-testid': 'review-canvas-annotation-mark',
    'data-annotation-id': annotation.id,
    opacity: activeId && activeId !== annotation.id ? 0.35 : 1,
  };
  if (!interactive) return <g {...attributes}>{graphic}</g>;
  const open = () => onActive(annotation.id);
  return (
    // biome-ignore lint/a11y/useSemanticElements: SVG groups preserve original-media coordinates; HTML buttons cannot represent an SVG region.
    <g
      {...attributes}
      role="button"
      tabIndex={0}
      aria-label={`打开标注 ${index + 1} 的讨论`}
      className="pointer-events-auto cursor-pointer focus:outline-none"
      onClick={open}
      onKeyDown={(event) => {
        if (event.key !== 'Enter' && event.key !== ' ') return;
        event.preventDefault();
        open();
      }}
    >
      {graphic}
    </g>
  );
}
