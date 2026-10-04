'use client';

import { type PointerEvent, type RefObject, useEffect, useRef, useState, type WheelEvent } from 'react';

type Size = { width: number; height: number };
type Offset = { x: number; y: number };

export function fitArtworkScale(viewport: Size, media: Size): number {
  if (!viewport.width || !viewport.height || !media.width || !media.height) return 1;
  return Math.min(viewport.width / media.width, viewport.height / media.height);
}

export function mediaPixelsForScreenPixels(screenPixels: number, renderedScale: number): number {
  return Math.max(1, Math.round(screenPixels / Math.max(renderedScale, 0.001)));
}

/** The image, video and every SVG layer live in one measured media rectangle. */
export function useArtworkViewport(viewport: RefObject<HTMLElement | null>, media: Size) {
  const [size, setSize] = useState<Size>({ width: 0, height: 0 });
  const [scale, setScale] = useState<number | null>(null);
  const [offset, setOffset] = useState<Offset>({ x: 0, y: 0 });
  const [panMode, setPanMode] = useState(false);
  const [spaceHeld, setSpaceHeld] = useState(false);
  const [hovered, setHovered] = useState(false);
  const gesture = useRef<{ id: number; x: number; y: number; offset: Offset } | null>(null);

  useEffect(() => {
    const element = viewport.current;
    if (!element || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(() => setSize({ width: element.clientWidth, height: element.clientHeight }));
    observer.observe(element);
    setSize({ width: element.clientWidth, height: element.clientHeight });
    return () => observer.disconnect();
  }, [viewport]);
  useEffect(() => {
    if (!hovered) {
      setSpaceHeld(false);
      return;
    }
    const editable = (target: EventTarget | null) =>
      target instanceof HTMLElement && Boolean(target.closest('input, textarea, [contenteditable="true"]'));
    const down = (event: KeyboardEvent) => {
      if (event.code !== 'Space' || event.isComposing || editable(event.target)) return;
      event.preventDefault();
      setSpaceHeld(true);
    };
    const up = (event: KeyboardEvent) => {
      if (event.code === 'Space') setSpaceHeld(false);
    };
    window.addEventListener('keydown', down);
    window.addEventListener('keyup', up);
    return () => {
      window.removeEventListener('keydown', down);
      window.removeEventListener('keyup', up);
    };
  }, [hovered]);

  const fit = fitArtworkScale(size, media);
  const renderedScale = scale ?? fit;
  const canPan = panMode || spaceHeld;
  const changeScale = (next: number) => {
    setScale(Math.min(8, Math.max(0.05, next)));
    setOffset({ x: 0, y: 0 });
  };
  const onWheel = (event: WheelEvent<HTMLElement>) => {
    if (event.target instanceof HTMLElement && event.target.closest('input, textarea, [contenteditable="true"]'))
      return;
    event.preventDefault();
    changeScale(renderedScale * Math.exp(-event.deltaY * 0.001));
  };
  const onPointerDownCapture = (event: PointerEvent<HTMLElement>) => {
    if (!canPan || event.button !== 0 || !Number.isInteger(event.pointerId) || gesture.current) return;
    if (event.target instanceof HTMLElement && event.target.closest('input, textarea, [contenteditable="true"]'))
      return;
    event.stopPropagation();
    event.preventDefault();
    gesture.current = { id: event.pointerId, x: event.clientX, y: event.clientY, offset };
    event.currentTarget.setPointerCapture(event.pointerId);
  };
  const onPointerMove = (event: PointerEvent<HTMLElement>) => {
    const current = gesture.current;
    if (!current || current.id !== event.pointerId) return;
    setOffset({ x: current.offset.x + event.clientX - current.x, y: current.offset.y + event.clientY - current.y });
  };
  const onPointerEnd = (event: PointerEvent<HTMLElement>) => {
    if (!Number.isInteger(event.pointerId) || gesture.current?.id !== event.pointerId) return;
    gesture.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId))
      event.currentTarget.releasePointerCapture(event.pointerId);
  };

  return {
    renderedScale,
    offset,
    panMode,
    canPan,
    setPanMode,
    fit: () => {
      setScale(null);
      setOffset({ x: 0, y: 0 });
    },
    actual: () => changeScale(1),
    zoomIn: () => changeScale(renderedScale * 1.25),
    zoomOut: () => changeScale(renderedScale / 1.25),
    handlers: {
      onWheel,
      onPointerDownCapture,
      onPointerMove,
      onPointerUp: onPointerEnd,
      onPointerCancel: onPointerEnd,
      onMouseEnter: () => setHovered(true),
      onMouseLeave: () => setHovered(false),
    },
    stageStyle:
      size.width && size.height
        ? {
            width: media.width * renderedScale,
            height: media.height * renderedScale,
            transform: `translate(${offset.x}px, ${offset.y}px)`,
          }
        : { width: '100%', height: '100%' },
  };
}
