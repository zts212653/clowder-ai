'use client';

import { useCallback, useEffect, useRef, useState } from 'react';

interface ResizeHandleProps {
  direction: 'horizontal' | 'vertical';
  onResize: (delta: number) => void;
  onDoubleClick?: () => void;
}

export function ResizeHandle({ direction, onResize, onDoubleClick }: ResizeHandleProps) {
  const [dragging, setDragging] = useState(false);
  const startPos = useRef(0);

  const handleMouseDown = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();
      setDragging(true);
      startPos.current = direction === 'horizontal' ? e.clientX : e.clientY;
    },
    [direction],
  );

  useEffect(() => {
    if (!dragging) return;

    const handleMouseMove = (e: MouseEvent) => {
      const currentPos = direction === 'horizontal' ? e.clientX : e.clientY;
      const delta = currentPos - startPos.current;
      if (delta !== 0) {
        onResize(delta);
        startPos.current = currentPos;
      }
    };

    const handleMouseUp = () => setDragging(false);

    document.addEventListener('mousemove', handleMouseMove);
    document.addEventListener('mouseup', handleMouseUp);
    return () => {
      document.removeEventListener('mousemove', handleMouseMove);
      document.removeEventListener('mouseup', handleMouseUp);
    };
  }, [dragging, direction, onResize]);

  const isH = direction === 'horizontal';

  return (
    <div
      role="separator"
      aria-orientation={isH ? 'vertical' : 'horizontal'}
      onMouseDown={handleMouseDown}
      onDoubleClick={onDoubleClick}
      className={`flex-shrink-0 group relative ${
        isH
          ? 'w-1 cursor-col-resize hover:bg-cocreator-primary/20 active:bg-cocreator-primary/30'
          : 'h-1 cursor-row-resize hover:bg-cocreator-primary/20 active:bg-cocreator-primary/30'
      } ${dragging ? 'bg-cocreator-primary/30' : ''} transition-colors`}
    >
      <div
        className={`absolute ${
          isH
            ? 'top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-0.5 h-8 rounded-full'
            : 'top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 h-0.5 w-8 rounded-full'
        } bg-cocreator-dark/20 group-hover:bg-cocreator-primary/50 transition-colors ${dragging ? 'bg-cocreator-primary/50' : ''}`}
      />
    </div>
  );
}
