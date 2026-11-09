import { type RefObject, useEffect, useRef } from 'react';

const focusable =
  'button:not(:disabled), a[href], input:not(:disabled), textarea:not(:disabled), select:not(:disabled), [tabindex="0"]';

function availableControls(root: HTMLElement) {
  return [...root.querySelectorAll<HTMLElement>(focusable)].filter(
    (node) =>
      !node.matches(':disabled') &&
      !node.closest('[hidden], [inert], [aria-hidden="true"]') &&
      node.getClientRects().length > 0 &&
      getComputedStyle(node).visibility !== 'hidden',
  );
}

function replacementGalleryControl(available: HTMLElement[], direction: string) {
  const arrow = available.find((node) => node.dataset.artworkGalleryDirection === direction);
  const selected = available.find((node) =>
    node.matches('[data-testid="artwork-gallery-thumbnails"] [aria-current="true"]'),
  );
  return arrow ?? selected;
}

function wrapTab(root: HTMLElement, event: KeyboardEvent) {
  const available = availableControls(root);
  const first = available[0],
    last = available.at(-1);
  if (!first || !last) return;
  const active = document.activeElement;
  if (active !== (event.shiftKey ? first : last)) return;
  event.preventDefault();
  (event.shiftKey ? last : first).focus({ preventScroll: true });
}

/** The stable dialog owns focus across replacement of its preview/owner subtree. */
export function useLightboxFocus(
  dialog: RefObject<HTMLElement>,
  closeButton: RefObject<HTMLButtonElement>,
  onClose: () => void,
) {
  const close = useRef(onClose);
  close.current = onClose;
  useEffect(() => {
    const root = dialog.current;
    if (!root) return;
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    let focused: HTMLElement | null = null;
    const remember = (event: FocusEvent) => {
      if (event.target instanceof HTMLElement) focused = event.target;
    };
    const repair = () => {
      const direction = focused?.dataset.artworkGalleryDirection;
      if (!focused || !direction || root.closest('[hidden], [inert], [aria-hidden="true"]')) return;
      const active = document.activeElement;
      // Explicit focus in another owner wins over recovery of a removed control.
      if (active !== document.body && active !== focused) return;
      const available = availableControls(root);
      if (available.includes(focused)) return;
      // Repair only the gallery lifecycle. Disabling or removing an owner's
      // save/input/work-mode control must never redirect activation to Close.
      replacementGalleryControl(available, direction)?.focus({ preventScroll: true });
    };
    root.addEventListener('focusin', remember);
    closeButton.current?.focus({ preventScroll: true });
    const changes = new MutationObserver(repair);
    changes.observe(root, {
      subtree: true,
      childList: true,
      attributes: true,
      attributeFilter: ['disabled', 'hidden', 'inert', 'aria-hidden'],
    });
    const keyboard = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.isComposing || document.fullscreenElement) return;
      if (event.key === 'Escape') {
        event.stopPropagation();
        close.current();
      }
      if (event.key === 'Tab') wrapTab(root, event);
    };
    document.addEventListener('keydown', keyboard);
    return () => {
      changes.disconnect();
      root.removeEventListener('focusin', remember);
      document.removeEventListener('keydown', keyboard);
      const active = document.activeElement;
      if (opener?.isConnected && (active === document.body || (active && root.contains(active))))
        opener.focus({ preventScroll: true });
    };
  }, [dialog, closeButton]);
}
