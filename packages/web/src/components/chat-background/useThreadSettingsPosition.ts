import { type RefObject, useLayoutEffect, useState } from 'react';

/** Anchor one stable settings popover; its content may change without moving its origin. */
export function useThreadSettingsPosition(open: boolean, enabled: boolean, trigger?: RefObject<HTMLElement | null>) {
  const [position, setPosition] = useState<{ top: number; left: number; maxHeight: number }>();
  useLayoutEffect(() => {
    if (!open || !enabled) return;
    const place = () => {
      const anchor = trigger?.current?.getBoundingClientRect();
      const width = Math.min(386, window.innerWidth - 16);
      const top = anchor ? Math.min(window.innerHeight - 120, anchor.bottom + 6) : 60;
      setPosition({
        top: Math.max(8, top),
        left: Math.max(8, Math.min(window.innerWidth - width - 8, (anchor?.right ?? window.innerWidth - 8) - width)),
        maxHeight: window.innerHeight - Math.max(8, top) - 8,
      });
    };
    place();
    window.addEventListener('resize', place);
    return () => window.removeEventListener('resize', place);
  }, [open, enabled, trigger]);
  return enabled ? position : undefined;
}
