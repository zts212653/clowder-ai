'use client';
import type { ImmutableMedia, VideoProjectReviewRegion } from '@cat-cafe/shared';
import { type RefObject, useEffect, useRef, useState } from 'react';
import { pointInMedia, regionBetween } from '../../content-review/review-geometry';

export function ScreeningRegion({
  video,
  media,
  ready,
  region,
  onRegion,
}: {
  video: RefObject<HTMLVideoElement>;
  media: Extract<ImmutableMedia, { kind: 'video' }>;
  ready: boolean;
  region?: VideoProjectReviewRegion;
  onRegion: (region: VideoProjectReviewRegion | undefined) => void;
}) {
  const start = useRef<{ x: number; y: number } | null>(null);
  // The player owns the chosen region; this component only previews an in-progress drag.
  const [dragBox, setDragBox] = useState<VideoProjectReviewRegion['bbox'] | null>(null);
  const bbox = dragBox ?? region?.bbox;
  const [size, setSize] = useState({ width: 0, height: 0 });
  useEffect(() => {
    const element = video.current;
    if (!element) return;
    const update = () => {
      const bounds = element.getBoundingClientRect();
      setSize({ width: bounds.width, height: bounds.height });
    };
    const observer = new ResizeObserver(update);
    observer.observe(element);
    update();
    return () => observer.disconnect();
  }, [video]);
  const scale = Math.min(size.width / media.width, size.height / media.height);
  const point = (event: React.PointerEvent) =>
    video.current
      ? pointInMedia({ x: event.clientX, y: event.clientY }, video.current.getBoundingClientRect(), media)
      : null;
  return (
    <div className="pointer-events-none absolute inset-0">
      <fieldset
        className="pointer-events-auto absolute inset-x-0 top-0 bottom-12 m-0 min-w-0 touch-none border-0 p-0"
        aria-label="拖选画面区域"
        onPointerDown={(event) => {
          if (!ready) return;
          const next = point(event);
          if (!next) return;
          start.current = next;
          event.currentTarget.setPointerCapture(event.pointerId);
          setDragBox(null);
          onRegion(undefined);
        }}
        onPointerMove={(event) => {
          const end = point(event);
          if (!start.current || !end) return;
          const region = regionBetween(start.current, end);
          setDragBox(region ? { x: region.x, y: region.y, width: region.width, height: region.height } : null);
        }}
        onPointerUp={(event) => {
          const end = point(event);
          setDragBox(null);
          if (!ready || !start.current || !end) {
            start.current = null;
            return;
          }
          const region = regionBetween(start.current, end);
          start.current = null;
          if (region)
            onRegion({
              coordinateSpace: 'display-pixels',
              width: media.width,
              height: media.height,
              rotation: media.rotation,
              bbox: { x: region.x, y: region.y, width: region.width, height: region.height },
            });
        }}
        onPointerCancel={() => {
          start.current = null;
          setDragBox(null);
          onRegion(undefined);
        }}
      />
      {bbox && (
        <div
          className="pointer-events-none absolute border-2 border-white bg-white/10"
          style={{
            left: (size.width - media.width * scale) / 2 + bbox.x * scale,
            top: (size.height - media.height * scale) / 2 + bbox.y * scale,
            width: bbox.width * scale,
            height: bbox.height * scale,
          }}
        />
      )}
    </div>
  );
}
