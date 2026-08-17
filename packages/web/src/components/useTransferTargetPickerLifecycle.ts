import { type RefObject, useCallback, useEffect, useRef } from 'react';

interface TransferPickerLifecycleInput {
  open: boolean;
  atCatStep: boolean;
  panelRef: RefObject<HTMLDivElement>;
  resetPicker: () => void;
  backToThreads: () => void;
  onClose: () => void;
}

export function useTransferTargetPickerLifecycle({
  open,
  atCatStep,
  panelRef,
  resetPicker,
  backToThreads,
  onClose,
}: TransferPickerLifecycleInput) {
  const wasOpenRef = useRef(false);
  const returnFocusRef = useRef<HTMLElement | null>(null);
  const restoreFocus = useCallback(() => queueMicrotask(() => returnFocusRef.current?.focus()), []);
  const close = useCallback(() => {
    onClose();
    restoreFocus();
  }, [onClose, restoreFocus]);

  useEffect(() => {
    if (open && !wasOpenRef.current) {
      returnFocusRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
      resetPicker();
      requestAnimationFrame(() => panelRef.current?.querySelector<HTMLElement>('button:not(:disabled)')?.focus());
    }
    wasOpenRef.current = open;
  }, [open, panelRef, resetPicker]);

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      if (atCatStep) backToThreads();
      else close();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [atCatStep, backToThreads, close, open]);

  return { close, restoreFocus };
}
