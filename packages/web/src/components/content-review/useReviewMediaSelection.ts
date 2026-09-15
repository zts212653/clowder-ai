'use client';
import type { ArtifactReviewAnchor, ImmutableMedia } from '@cat-cafe/shared';
import { type PointerEvent, type RefObject, useCallback, useEffect, useRef, useState } from 'react';
import type { ReviewCanvasMode } from './ReviewCanvasToolbar';
import { type MediaPoint, pointInMedia, regionBetween } from './review-geometry';
import type { ReviewMarkupFrame } from './review-markup-draft';

/** One pointer, media identity and presented frame own a transient selection until finish or cancellation. */
export function useReviewMediaSelection({
  media,
  mode,
  canAnnotate,
  selected,
  onSelect,
  stage,
  frame,
  identity,
}: {
  media: ImmutableMedia;
  mode: ReviewCanvasMode;
  canAnnotate: boolean;
  selected: ArtifactReviewAnchor | null;
  onSelect: (anchor: ArtifactReviewAnchor) => void;
  stage: RefObject<HTMLDivElement>;
  frame: ReviewMarkupFrame | null;
  identity: string;
}) {
  const [selecting, setSelecting] = useState(false);
  const [drag, setDrag] = useState<ArtifactReviewAnchor | null>(null);
  const start = useRef<MediaPoint | null>(null);
  const capture = useRef<{
    target: SVGSVGElement;
    pointerId: number;
    identity: string;
    mode: ReviewCanvasMode;
    frame: ReviewMarkupFrame | null;
    frameIdentity: string;
    clientStart: MediaPoint;
    moved: boolean;
  } | null>(null);
  const commentMode = mode === 'comment';
  const selectionActive = commentMode || (mode === 'view' && selecting);
  const frameIdentity =
    media.kind === 'image' ? 'image' : frame ? `${frame.streamId}:${frame.tick}` : 'frame-unavailable';
  const release = useCallback(() => {
    const held = capture.current;
    capture.current = null;
    start.current = null;
    if (held?.target.hasPointerCapture(held.pointerId)) held.target.releasePointerCapture(held.pointerId);
  }, []);
  const cancel = useCallback(() => {
    release();
    setDrag(null);
    setSelecting(false);
  }, [release]);
  useEffect(() => {
    cancel();
    return release;
  }, [identity, mode, canAnnotate, cancel, release]);
  useEffect(() => {
    if (capture.current && capture.current.frameIdentity !== frameIdentity) cancel();
  }, [frameIdentity, cancel]);

  function pointer(event: PointerEvent<SVGSVGElement>, clamp = false) {
    const bounds = stage.current?.getBoundingClientRect();
    return bounds ? pointInMedia({ x: event.clientX, y: event.clientY }, bounds, media, clamp) : null;
  }
  function owns(event: PointerEvent<SVGSVGElement>) {
    const held = capture.current;
    return (
      held?.target === event.currentTarget &&
      held.pointerId === event.pointerId &&
      held.identity === identity &&
      held.mode === mode &&
      held.frameIdentity === frameIdentity
    );
  }
  function toAnchor(
    region: Extract<ArtifactReviewAnchor, { kind: 'image-region' | 'image-point' }>,
    atFrame: ReviewMarkupFrame | null,
  ): ArtifactReviewAnchor | null {
    if (media.kind === 'image') return region;
    if (!atFrame || atFrame.tick < media.startTick || atFrame.tick >= media.startTick + media.durationTicks)
      return null;
    const range =
      selected?.kind === 'video-range'
        ? selected
        : { startTick: media.startTick, endTick: media.startTick + media.durationTicks };
    const tick = atFrame.tick;
    return {
      kind: 'video-range',
      streamId: atFrame.streamId,
      startTick: Math.min(range.startTick, tick),
      endTick: Math.max(range.endTick, tick + 1),
      ...(region.kind === 'image-point'
        ? { framePoint: { tick, x: region.x, y: region.y } }
        : { frameRegion: { tick, x: region.x, y: region.y, width: region.width, height: region.height } }),
    };
  }
  function onPointerDown(event: PointerEvent<SVGSVGElement>) {
    if (
      !selectionActive ||
      !canAnnotate ||
      capture.current ||
      (commentMode && event.target instanceof Element && event.target.closest('[data-annotation-id]'))
    )
      return;
    if (media.kind === 'video' && !frame) return;
    const point = pointer(event);
    if (!point) return;
    start.current = point;
    event.currentTarget.setPointerCapture(event.pointerId);
    capture.current = {
      target: event.currentTarget,
      pointerId: event.pointerId,
      identity,
      mode,
      frame,
      frameIdentity,
      clientStart: { x: event.clientX, y: event.clientY },
      moved: false,
    };
    event.preventDefault();
  }
  function onPointerMove(event: PointerEvent<SVGSVGElement>) {
    const held = capture.current;
    if (!held || held.target !== event.currentTarget || held.pointerId !== event.pointerId) return;
    if (!owns(event) || !canAnnotate || !selectionActive) return cancel();
    if (!start.current) return;
    if (Math.hypot(event.clientX - held.clientStart.x, event.clientY - held.clientStart.y) >= 5) held.moved = true;
    const end = pointer(event, true);
    const region = end ? regionBetween(start.current, end) : null;
    if (region) setDrag(toAnchor(region, held.frame));
  }
  function onPointerUp(event: PointerEvent<SVGSVGElement>) {
    const held = capture.current;
    if (!held || held.target !== event.currentTarget || held.pointerId !== event.pointerId) return;
    if (!owns(event) || !canAnnotate || !selectionActive || !start.current) return cancel();
    const end = pointer(event, true);
    const isTap = !held.moved && Math.hypot(event.clientX - held.clientStart.x, event.clientY - held.clientStart.y) < 5;
    const region =
      end && isTap && commentMode
        ? { kind: 'image-point' as const, ...start.current }
        : end
          ? regionBetween(start.current, end)
          : null;
    const anchor = region ? toAnchor(region, held.frame) : null;
    cancel();
    if (anchor) onSelect(anchor);
  }
  function cancelPointer(event: PointerEvent<SVGSVGElement>, cancelArmed = false) {
    const held = capture.current;
    if ((cancelArmed && !held) || (held?.target === event.currentTarget && held.pointerId === event.pointerId))
      cancel();
  }
  return {
    selecting,
    setSelecting,
    drag,
    selectionActive,
    handlers: {
      onPointerDown,
      onPointerMove,
      onPointerUp,
      onPointerCancel: (event: PointerEvent<SVGSVGElement>) => cancelPointer(event, true),
      onLostPointerCapture: cancelPointer,
    },
  };
}
