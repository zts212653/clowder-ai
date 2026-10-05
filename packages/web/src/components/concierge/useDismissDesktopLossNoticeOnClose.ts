'use client';

import { useEffect, useRef } from 'react';
import { dismissConciergeDesktopLossNotice } from '@/stores/conciergeDesktopStore';
import type { SurfaceState } from '@/stores/conciergeStore';

/** Leaving the cat surface closes its notice without changing desktop presence. */
export function useDismissDesktopLossNoticeOnClose(
  desktopLost: boolean,
  surfaceState: SurfaceState,
  muted: boolean,
): void {
  const previousSurface = useRef({ surfaceState, muted });
  useEffect(() => {
    const previous = previousSurface.current;
    previousSurface.current = { surfaceState, muted };
    if (
      desktopLost &&
      ((previous.surfaceState === 'bubble' && surfaceState !== 'bubble') ||
        (previous.surfaceState === 'toolbar' && surfaceState === 'collapsed') ||
        (!previous.muted && muted))
    )
      dismissConciergeDesktopLossNotice();
  }, [desktopLost, surfaceState, muted]);
}
