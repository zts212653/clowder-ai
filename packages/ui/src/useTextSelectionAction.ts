import { type RefObject, useEffect, useState } from 'react';
import {
  projectSelectionAction,
  type SelectionProjectionAdapter,
  type TextSelectionAction,
} from './selection-action-projection';

export function useTextSelectionAction(
  containerRef: RefObject<HTMLElement>,
  active: boolean,
  resetKey: string | null,
  coordinateSpace: 'container' | 'viewport' = 'container',
  projection?: SelectionProjectionAdapter,
): TextSelectionAction | null {
  const [action, setAction] = useState<TextSelectionAction | null>(null);

  useEffect(() => {
    // resetKey is an explicit invalidation token: a new message/file must reinstall
    // the selection projection even when every other dependency is unchanged.
    void resetKey;
    const container = containerRef.current;
    if (!container || !active) {
      setAction(null);
      return;
    }

    const sync = () => setAction(projectSelectionAction(window.getSelection(), container, coordinateSpace, projection));

    document.addEventListener('selectionchange', sync);
    document.addEventListener('scroll', sync, true);
    window.addEventListener('resize', sync);
    const resizeObserver = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(sync);
    resizeObserver?.observe(container);
    sync();
    return () => {
      document.removeEventListener('selectionchange', sync);
      document.removeEventListener('scroll', sync, true);
      window.removeEventListener('resize', sync);
      resizeObserver?.disconnect();
    };
  }, [active, containerRef, coordinateSpace, resetKey, projection]);

  return action;
}
