import { useRef } from 'react';

/** Keep the existing list mounted and return to its exact scroll and focus position. */
export function useMemberReturn() {
  const host = useRef<HTMLDivElement>(null);
  const location = useRef<{ focus: Element | null; scroll: HTMLElement | null; top: number } | null>(null);
  const remember = () => {
    const scroll = host.current?.closest<HTMLElement>('[data-trajectory-origin-scroll]') ?? null;
    location.current = { focus: document.activeElement, scroll, top: scroll?.scrollTop ?? 0 };
    if (scroll) scroll.scrollTop = 0;
  };
  const restore = () =>
    requestAnimationFrame(() => {
      const saved = location.current;
      if (saved?.scroll) saved.scroll.scrollTop = saved.top;
      if (saved?.focus instanceof HTMLElement && saved.focus.isConnected) saved.focus.focus({ preventScroll: true });
    });
  return { host, remember, restore };
}
