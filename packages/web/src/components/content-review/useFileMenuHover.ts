import { type RefObject, useEffect, useRef } from 'react';

/** Pointer and focus extend one menu lifetime; menu state never feeds back as user input. */
export function useFileMenuHover(
  context: RefObject<HTMLElement | null> | undefined,
  menu: RefObject<HTMLElement | null>,
  enabled: boolean,
  open: (owner: HTMLElement) => void,
  close: () => void,
) {
  const actions = useRef({ open, close });
  actions.current = { open, close };
  useEffect(() => {
    const owner = context?.current;
    if (!enabled || !owner) return;
    let pointerInside = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const cancel = () => clearTimeout(timer);
    const scheduleClose = () => {
      cancel();
      timer = setTimeout(() => {
        const focused = document.activeElement;
        const keepsFocus =
          focused && owner.contains(focused) && (menu.current?.contains(focused) || focused.matches(':focus-visible'));
        if (!pointerInside && !keepsFocus) actions.current.close();
      }, 150);
    };
    const enter = (event: PointerEvent) => {
      if (event.pointerType === 'touch') return;
      pointerInside = true;
      cancel();
      // Pointer exploration must not open a second menu over a keyboard-owned one.
      if (!menu.current && !document.activeElement?.closest('[role="menu"]')) actions.current.open(owner);
    };
    const leave = (event: PointerEvent) => {
      if (event.relatedTarget instanceof Node && owner.contains(event.relatedTarget)) return;
      pointerInside = false;
      scheduleClose();
    };
    const focus = (event: FocusEvent) => {
      cancel();
      // Clicking a chip also focuses it; only keyboard focus previews actions.
      if (!menu.current && event.target instanceof Element && event.target.matches(':focus-visible')) {
        actions.current.open(owner);
      }
    };
    const blur = (event: FocusEvent) => {
      if (!(event.relatedTarget instanceof Node && owner.contains(event.relatedTarget))) scheduleClose();
    };
    owner.addEventListener('pointerenter', enter);
    owner.addEventListener('pointerleave', leave);
    owner.addEventListener('focusin', focus);
    owner.addEventListener('focusout', blur);
    return () => {
      cancel();
      owner.removeEventListener('pointerenter', enter);
      owner.removeEventListener('pointerleave', leave);
      owner.removeEventListener('focusin', focus);
      owner.removeEventListener('focusout', blur);
    };
  }, [context, menu, enabled]);
}
