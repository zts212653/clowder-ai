import { type ReactNode, type RefObject, useEffect, useRef } from 'react';

/** Native modal keeps keyboard focus inside and restores focus on close. */
export function MaterialDialogFrame({
  label,
  children,
  onClose,
  busy = false,
  className = 'material-dialog',
  initialFocusRef,
}: {
  label: string;
  children: ReactNode;
  onClose(): void;
  busy?: boolean;
  className?: string;
  initialFocusRef?: RefObject<HTMLElement | null>;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const previousFocus = useRef<HTMLElement | undefined>(
    typeof document !== 'undefined' && document.activeElement instanceof HTMLElement
      ? document.activeElement
      : undefined,
  );
  useEffect(() => {
    const element = dialog.current;
    if (!element) return;
    if (typeof element.showModal === 'function') element.showModal();
    else element.setAttribute('open', '');
    initialFocusRef?.current?.focus();
    return () => {
      if (typeof element.close === 'function' && element.open) element.close();
      else element.removeAttribute('open');
      if (previousFocus.current?.isConnected) previousFocus.current.focus();
    };
  }, [initialFocusRef]);
  return (
    <dialog
      ref={dialog}
      aria-label={label}
      aria-busy={busy || undefined}
      className={className}
      onCancel={(event) => {
        event.preventDefault();
        if (!busy) onClose();
      }}
    >
      {children}
    </dialog>
  );
}
