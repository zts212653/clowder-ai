import { type ReactNode, useEffect, useRef } from 'react';

/** Native modal keeps keyboard focus inside and restores focus on close. */
export function MaterialDialogFrame({
  label,
  children,
  onClose,
  busy = false,
}: {
  label: string;
  children: ReactNode;
  onClose(): void;
  busy?: boolean;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const element = dialog.current;
    element?.showModal();
    return () => element?.close();
  }, []);
  return (
    <dialog
      ref={dialog}
      aria-label={label}
      className="material-dialog"
      onCancel={(event) => {
        event.preventDefault();
        if (!busy) onClose();
      }}
    >
      {children}
    </dialog>
  );
}
