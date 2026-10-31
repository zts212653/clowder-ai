'use client';
import { type RefObject, useCallback, useEffect, useRef, useState } from 'react';
/** Reveal the existing owner's catalogue in scroll-sized batches; never truncate its source. */
export function useProgressiveWorks(
  total: number,
  resetKey: string,
  root?: RefObject<HTMLElement | null>,
  required = 0,
) {
  const [window, setWindow] = useState({ key: resetKey, count: 24 });
  const count = window.key === resetKey ? window.count : 24;
  const limit = Math.min(total, Math.max(count, required));
  const more = limit < total;
  const sentinel = useRef<HTMLButtonElement>(null);
  const loadMore = useCallback(() => {
    setWindow((current) => ({
      key: resetKey,
      count: Math.max(current.key === resetKey ? current.count : 24, required) + 24,
    }));
  }, [resetKey, required]);
  useEffect(() => {
    const target = sentinel.current;
    if (!more || !target || typeof IntersectionObserver === 'undefined') return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) loadMore();
      },
      { root: root?.current ?? null, rootMargin: '240px' },
    );
    observer.observe(target);
    return () => observer.disconnect();
  }, [more, limit, loadMore, root]);
  return { limit, more, sentinel, loadMore };
}
