import { useLayoutEffect, useRef } from 'react';
import { DEFAULT_READING, type EvolutionReading, useEvolutionReading } from './evolution-reading-state';

/** Scrolling stays outside the subscribed store; navigation and page departure commit the last position. */
export function useEvolutionScroll(programId: string, view: keyof EvolutionReading['scroll'], ready: boolean) {
  const viewport = useRef<HTMLDivElement>(null);
  const pending = useRef<number>();
  useLayoutEffect(() => {
    if (!ready || !viewport.current) return;
    viewport.current.scrollTop = (useEvolutionReading.getState().programs[programId] ?? DEFAULT_READING).scroll[view];
    const flush = () => {
      if (pending.current === undefined) return;
      const scroll = (useEvolutionReading.getState().programs[programId] ?? DEFAULT_READING).scroll;
      const top = pending.current;
      pending.current = undefined;
      if (scroll[view] !== top)
        useEvolutionReading.getState().update(programId, { scroll: { ...scroll, [view]: top } });
    };
    const hide = () => {
      if (document.visibilityState === 'hidden') flush();
    };
    const unsubscribe = useEvolutionReading.subscribe((next, previous) => {
      const reading = next.programs[programId] ?? DEFAULT_READING;
      const before = previous.programs[programId] ?? DEFAULT_READING;
      // An exact source navigation resets its view even when the old persisted offset was already zero.
      if (
        reading.scroll[view] !== before.scroll[view] ||
        (reading.scroll !== before.scroll && reading.selectedVersionRef !== before.selectedVersionRef)
      ) {
        pending.current = undefined;
        if (viewport.current) viewport.current.scrollTop = reading.scroll[view];
      }
    });
    window.addEventListener('pagehide', flush);
    document.addEventListener('visibilitychange', hide);
    return () => {
      flush();
      unsubscribe();
      window.removeEventListener('pagehide', flush);
      document.removeEventListener('visibilitychange', hide);
    };
  }, [programId, view, ready]);
  return {
    viewport,
    onScroll: (top: number) => {
      pending.current = top;
    },
  };
}
