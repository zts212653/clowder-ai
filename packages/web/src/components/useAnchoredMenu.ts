import { type KeyboardEvent, type RefObject, useId, useLayoutEffect, useRef } from 'react';

/** Keep related menus in their DOM focus scope while escaping scroll clipping in the browser top layer. */
export function useAnchoredMenu(
  open: boolean,
  anchor: RefObject<HTMLButtonElement>,
  menu: RefObject<HTMLDivElement>,
  onClose: () => void,
  submenu = false,
) {
  const menuId = useId();
  const close = useRef(onClose);
  close.current = onClose;
  useLayoutEffect(() => {
    if (!open) return;
    const trigger = anchor.current;
    const panel = menu.current;
    if (!trigger || !panel) return;
    // Same native top-layer primitive as FileActionMenu; optional only for DOM-only test environments.
    panel.showPopover?.();
    let placedRect = trigger.getBoundingClientRect();
    const place = () => {
      const rect = trigger.getBoundingClientRect();
      placedRect = rect;
      if (rect.top >= window.innerHeight || rect.bottom < 0 || rect.left >= window.innerWidth || rect.right < 0) {
        close.current();
        return;
      }
      const width = panel.getBoundingClientRect().width;
      const height = panel.scrollHeight + 2;
      const below = Math.max(0, window.innerHeight - rect.bottom - 12);
      const above = Math.max(0, rect.top - 12);
      const up = below < height && above > below;
      let left = rect.right - width;
      let maxHeight = up ? above : below;
      let top = up ? rect.top - 4 - Math.min(height, maxHeight) : rect.bottom + 4;
      if (submenu) {
        const parent = trigger.closest('[role="menu"]')?.getBoundingClientRect();
        if (parent) left = parent.right + width + 12 <= window.innerWidth ? parent.right + 4 : parent.left - width - 4;
        maxHeight = window.innerHeight - 16;
        top = Math.min(rect.top, window.innerHeight - Math.min(height, maxHeight) - 8);
      }
      Object.assign(panel.style, {
        left: `${Math.max(8, Math.min(left, window.innerWidth - width - 8))}px`,
        top: `${Math.max(8, top)}px`,
        maxHeight: `${maxHeight}px`,
        visibility: 'visible',
      });
    };
    place();
    panel.querySelector<HTMLButtonElement>('[role="menuitem"]:not(:disabled)')?.focus({ preventScroll: true });
    const dismiss = () => {
      close.current();
      if (panel.contains(document.activeElement)) trigger.focus({ preventScroll: true });
    };
    const scroll = (event: Event) => {
      if (!(event.target instanceof Node) || !event.target.contains(trigger)) return;
      const rect = trigger.getBoundingClientRect();
      // Live list remeasurement can compensate scrollTop while the trigger stays
      // in place. Dismiss only when scrolling actually moves the menu's anchor.
      if (rect.top !== placedRect.top || rect.left !== placedRect.left) dismiss();
    };
    const observer = new ResizeObserver(place);
    observer.observe(trigger.closest('[data-testid="sidebar-thread-list"]') ?? trigger);
    observer.observe(panel);
    window.addEventListener('resize', dismiss);
    window.addEventListener('scroll', scroll, true);
    return () => {
      observer.disconnect();
      window.removeEventListener('resize', dismiss);
      window.removeEventListener('scroll', scroll, true);
    };
  }, [open, anchor, menu, submenu]);

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    // Tab exits the whole hierarchy through its root menu.
    if (submenu && event.key === 'Tab') return;
    if (event.key === 'Escape' || (submenu && event.key === 'ArrowLeft') || event.key === 'Tab') {
      close.current();
      anchor.current?.focus({ preventScroll: true });
      if (event.key !== 'Tab') {
        event.preventDefault();
        event.stopPropagation();
      }
      return;
    }
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    event.stopPropagation();
    const items = Array.from(event.currentTarget.querySelectorAll<HTMLElement>('[role="menuitem"]:not(:disabled)'));
    const index = items.indexOf(document.activeElement as HTMLElement);
    const next =
      event.key === 'Home'
        ? 0
        : event.key === 'End'
          ? items.length - 1
          : (index + (event.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length;
    items[next]?.focus();
  };
  return { menuId, onKeyDown };
}
