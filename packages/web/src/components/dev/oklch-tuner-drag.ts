/*
 * F056 OKLCH Tuner — drag hook
 *
 * Minimal hook for making the Tuner panel draggable by its header.
 * Uses refs to avoid stale-closure issues with mousemove.
 */
import { useCallback, useRef, useState } from 'react';

interface Pos {
  x: number;
  y: number;
}

export function useDrag(initial: Pos) {
  const [pos, setPos] = useState(initial);
  const posRef = useRef(initial);
  posRef.current = pos;

  const onPointerDown = useCallback((e: React.PointerEvent) => {
    /* Only drag via primary button */
    if (e.button !== 0) return;
    e.preventDefault();
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
    const startX = e.clientX - posRef.current.x;
    const startY = e.clientY - posRef.current.y;
    const onMove = (ev: PointerEvent) => {
      const nx = Math.max(0, ev.clientX - startX);
      const ny = Math.max(0, ev.clientY - startY);
      setPos({ x: nx, y: ny });
    };
    const onUp = () => {
      document.removeEventListener('pointermove', onMove);
      document.removeEventListener('pointerup', onUp);
    };
    document.addEventListener('pointermove', onMove);
    document.addEventListener('pointerup', onUp);
  }, []);

  return { pos, onPointerDown } as const;
}
