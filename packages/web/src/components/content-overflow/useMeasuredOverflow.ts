'use client';

import { useCallback, useEffect, useRef, useState } from 'react';

interface MeasuredOverflowOptions {
  axis: 'inline' | 'block';
  active?: boolean;
}

const OVERFLOW_TOLERANCE_PX = 1;

export function useMeasuredOverflow<T extends HTMLElement>({ axis, active = true }: MeasuredOverflowOptions) {
  const ref = useRef<T>(null);
  const [overflowing, setOverflowing] = useState(false);

  const measure = useCallback(() => {
    const element = ref.current;
    if (!element || !active) return;

    const next =
      axis === 'inline'
        ? element.scrollWidth > element.clientWidth + OVERFLOW_TOLERANCE_PX
        : element.scrollHeight > element.clientHeight + OVERFLOW_TOLERANCE_PX;
    setOverflowing(next);
  }, [active, axis]);

  useEffect(() => {
    if (active) measure();
  });

  useEffect(() => {
    const element = ref.current;
    if (!element || !active) return;

    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(measure);
    observer?.observe(element);
    window.addEventListener('resize', measure);

    return () => {
      observer?.disconnect();
      window.removeEventListener('resize', measure);
    };
  }, [active, measure]);

  return { ref, overflowing };
}
