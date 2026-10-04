'use client';
import type { ArtifactReviewAnchor, ImmutableMedia } from '@cat-cafe/shared';
import type { ReactNode } from 'react';
import { anchorBounds, tickToBrowserTime } from './review-geometry';

type CanvasAnnotation = { readonly id: string; readonly anchor: ArtifactReviewAnchor };

export function ReviewCanvasAnnotations({
  annotations,
  media,
  activeId,
  seconds,
  interactive = true,
  onActive,
}: {
  annotations: readonly CanvasAnnotation[];
  media: ImmutableMedia;
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
  annotation: CanvasAnnotation;
  index: number;
  media: ImmutableMedia;
  activeId: string | null;
  seconds: number;
  interactive: boolean;
  onActive: (annotationId: string) => void;
}) {
  const projection = projectAnnotation(annotation.anchor, media, seconds);
  if (!projection) return null;
  const graphic = <AnnotationGraphic {...projection} active={activeId === annotation.id} index={index} media={media} />;
  const attributes = {
    'data-testid': 'review-canvas-annotation-mark',
    'data-annotation-id': annotation.id,
    opacity: activeId && activeId !== annotation.id ? 0.35 : 1,
  };
  if (!interactive) return <g {...attributes}>{graphic}</g>;
  return (
    <InteractiveAnnotationMark attributes={attributes} index={index} annotationId={annotation.id} onActive={onActive}>
      {graphic}
    </InteractiveAnnotationMark>
  );
}

function projectAnnotation(anchor: ArtifactReviewAnchor, media: ImmutableMedia, seconds: number) {
  const box = anchorBounds(anchor);
  if (!box || !isVisibleAtFrame(anchor, media, seconds)) return null;
  return {
    box,
    isPoint: anchor.kind === 'image-point' || (anchor.kind === 'video-range' && !!anchor.framePoint),
  };
}

function isVisibleAtFrame(anchor: ArtifactReviewAnchor, media: ImmutableMedia, seconds: number) {
  if (media.kind !== 'video' || anchor.kind !== 'video-range') return true;
  return seconds >= tickToBrowserTime(anchor.startTick, media) && seconds < tickToBrowserTime(anchor.endTick, media);
}

function AnnotationGraphic({
  box,
  isPoint,
  active,
  index,
  media,
}: {
  box: NonNullable<ReturnType<typeof anchorBounds>>;
  isPoint: boolean;
  active: boolean;
  index: number;
  media: ImmutableMedia;
}) {
  return (
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
          strokeWidth={active ? 3 : 1.5}
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
}

function InteractiveAnnotationMark({
  attributes,
  index,
  annotationId,
  onActive,
  children,
}: {
  attributes: Record<string, string | number | undefined>;
  index: number;
  annotationId: string;
  onActive: (annotationId: string) => void;
  children: ReactNode;
}) {
  const open = () => onActive(annotationId);
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
      {children}
    </g>
  );
}
