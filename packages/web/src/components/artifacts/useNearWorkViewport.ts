'use client';
import { useEffect, useRef, useState } from 'react';

/** Mount media and read cover metadata only within one small scroll margin of the reader. */
export function useNearWorkViewport<T extends HTMLElement>({ rootMargin = '200px', once = true } = {}) {
  const ref = useRef<T>(null);
  const [near, setNear] = useState(false);
  useEffect(() => {
    const element = ref.current;
    if (!element) return;
    if (typeof IntersectionObserver === 'undefined') {
      setNear(true);
      return;
    }
    const observer = new IntersectionObserver(
      (entries) => {
        const visible = entries.some((entry) => entry.isIntersecting);
        setNear(visible);
        if (visible && once) observer.disconnect();
      },
      { rootMargin },
    );
    observer.observe(element);
    return () => observer.disconnect();
  }, [rootMargin, once]);
  return { ref, near };
}
