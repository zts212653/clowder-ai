'use client';

import {
  type PointerEvent,
  type WheelEvent as ReactWheelEvent,
  type RefObject,
  useEffect,
  useRef,
  useState,
} from 'react';

type Size = { width: number; height: number };
type Offset = { x: number; y: number };

export function fitArtworkScale(viewport: Size, media: Size, maximum = Number.POSITIVE_INFINITY): number {
  if (!viewport.width || !viewport.height || !media.width || !media.height) return 1;
  return Math.min(maximum, viewport.width / media.width, viewport.height / media.height);
}

export function mediaPixelsForScreenPixels(screenPixels: number, renderedScale: number): number {
  return Math.max(1, Math.round(screenPixels / Math.max(renderedScale, 0.001)));
}

/** The image, video and every SVG layer live in one measured media rectangle. */
export function useArtworkViewport(
  viewport: RefObject<HTMLElement | null>,
  media: Size,
  maximumFitScale = Number.POSITIVE_INFINITY,
  scrollZoomedImage = false,
  horizontalPaging = false,
) {
  const [size, setSize] = useState<Size & { top: number }>({ width: 0, height: 0, top: 0 });
  const [scale, setScale] = useState<number | null>(null);
  const [offset, setOffset] = useState<Offset>({ x: 0, y: 0 });
  const [panMode, setPanMode] = useState(false);
  const [spaceHeld, setSpaceHeld] = useState(false);
  const [hovered, setHovered] = useState(false);
  const gesture = useRef<{ id: number; x: number; y: number; offset: Offset } | null>(null);

  useEffect(() => {
    const element = viewport.current;
    if (!element || typeof ResizeObserver === 'undefined') return;
    const measure = () => setSize({ width: element.clientWidth, height: element.clientHeight, top: element.offsetTop });
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    measure();
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

  const fit = fitArtworkScale(size, media, maximumFitScale);
  const renderedScale = scale ?? fit;
  const fitsVertically = media.height * renderedScale <= size.height;
  const canPan = panMode || spaceHeld;
  const overflow = (nextScale: number) => ({
    x: Math.max(0, (media.width * nextScale - size.width) / 2),
    y: Math.max(0, (media.height * nextScale - size.height) / 2),
  });
  const constrain = (next: Offset) => {
    if (!scrollZoomedImage) return next;
    const bounds = overflow(renderedScale);
    return { x: Math.min(bounds.x, Math.max(-bounds.x, next.x)), y: Math.min(bounds.y, Math.max(-bounds.y, next.y)) };
  };
  const changeScale = (next: number) => {
    const nextScale = Math.min(8, Math.max(0.05, next));
    setScale(nextScale);
    setOffset(scrollZoomedImage ? overflow(nextScale) : { x: 0, y: 0 });
  };
  const onWheel = (event: ReactWheelEvent<HTMLElement> | WheelEvent) => {
    if (event.target instanceof HTMLElement && event.target.closest('input, textarea, [contenteditable="true"]'))
      return;
    // A fitted gallery gives horizontal swipes to its pager. A wider, zoomed image
    // still owns horizontal panning; vertical scroll and modifier zoom stay local.
    if (
      horizontalPaging &&
      !event.ctrlKey &&
      !event.metaKey &&
      Math.abs(event.deltaX) > Math.abs(event.deltaY) &&
      overflow(renderedScale).x < 0.5
    )
      return;
    event.preventDefault();
    if (scrollZoomedImage && !event.ctrlKey && !event.metaKey) {
      const factor = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? size.height : 1;
      setOffset((current) => constrain({ x: current.x - event.deltaX * factor, y: current.y - event.deltaY * factor }));
    } else changeScale(renderedScale * Math.exp(-event.deltaY * 0.001));
  };
  const wheelHandler = useRef(onWheel);
  wheelHandler.current = onWheel;
  useEffect(() => {
    if (!scrollZoomedImage) return;
    const element = viewport.current;
    if (!element) return;
    // React's delegated wheel listener is passive. The image owns this wheel gesture and must cancel
    // native scroll before translating its one media rectangle, including at either image boundary.
    const wheel = (event: WheelEvent) => wheelHandler.current(event);
    element.addEventListener('wheel', wheel, { passive: false });
    return () => element.removeEventListener('wheel', wheel);
  }, [viewport, scrollZoomedImage]);
  const onPointerDownCapture = (event: PointerEvent<HTMLElement>) => {
    if (!canPan || event.button !== 0 || !Number.isInteger(event.pointerId) || gesture.current) return;
    if (
      event.target instanceof Element &&
      event.target.closest('button, a[href], input, select, textarea, [role="button"], [contenteditable="true"]')
    )
      return;
    event.stopPropagation();
    event.preventDefault();
    gesture.current = { id: event.pointerId, x: event.clientX, y: event.clientY, offset };
    event.currentTarget.setPointerCapture(event.pointerId);
  };
  const onPointerMove = (event: PointerEvent<HTMLElement>) => {
    const current = gesture.current;
    if (!current || current.id !== event.pointerId) return;
    setOffset(
      constrain({ x: current.offset.x + event.clientX - current.x, y: current.offset.y + event.clientY - current.y }),
    );
  };
  const onPointerEnd = (event: PointerEvent<HTMLElement>) => {
    if (!Number.isInteger(event.pointerId) || gesture.current?.id !== event.pointerId) return;
    gesture.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId))
      event.currentTarget.releasePointerCapture(event.pointerId);
  };

  return {
    renderedScale,
    mediaBottom:
      size.top +
      (scrollZoomedImage && fitsVertically
        ? media.height * renderedScale
        : (size.height + media.height * renderedScale) / 2) +
      offset.y,
    fitsVertically,
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
      onWheel: scrollZoomedImage ? undefined : onWheel,
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
