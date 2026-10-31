'use client';

import { useEffect, useState } from 'react';

/**
 * A wall clock for elapsed / "waited N minutes" lines. It only ticks while `active` (nothing to count → no timer), and
 * every tick is a plain re-render of the card that asked, so the numbers on screen are always `Date.now() - startedAt`
 * of the canonical projection rather than a counter the card keeps on its own.
 */
export function useHomeClock(active: boolean, intervalMs: number): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), intervalMs);
    return () => window.clearInterval(timer);
  }, [active, intervalMs]);
  return now;
}
