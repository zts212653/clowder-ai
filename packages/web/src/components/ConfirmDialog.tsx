'use client';

import { type KeyboardEvent, type RefObject, useEffect, useId, useRef, useState } from 'react';
import { useActionSurfaceRef } from './message-v2/message-action-ownership';

interface ConfirmDialogProps {
  open: boolean;
  title: string;
  message: string;
  /** If set, shows a text input that must match this value to confirm */
  requireInput?: string;
  inputPlaceholder?: string;
  confirmLabel?: string;
  cancelLabel?: string;
  variant?: 'danger' | 'default';
  returnFocusRef?: RefObject<HTMLElement>;
  onConfirm: () => void;
  onCancel: () => void;
}

export function ConfirmDialog({
  open,
  title,
  message,
  requireInput,
  inputPlaceholder,
  confirmLabel = '确认',
  cancelLabel = '取消',
  variant = 'default',
  returnFocusRef,
  onConfirm,
  onCancel,
}: ConfirmDialogProps) {
  const [inputValue, setInputValue] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);
  const titleId = useId();
  const actionSurfaceRef = useActionSurfaceRef<HTMLDivElement>();

  useEffect(() => {
    if (!open) return;
    const origin = document.activeElement;
    const dialog = dialogRef.current;
    setInputValue('');
    (inputRef.current ?? cancelRef.current)?.focus({ preventScroll: true });
    return () => {
      // A later overlay may have taken focus. Only restore this dialog's own focus transition.
      if (document.activeElement !== document.body && !dialog?.contains(document.activeElement)) return;
      const target =
        origin instanceof HTMLElement && origin.isConnected && !origin.matches(':disabled, [aria-disabled="true"]')
          ? origin
          : returnFocusRef?.current;
      if (target?.isConnected) target.focus({ preventScroll: true });
    };
  }, [open, returnFocusRef]);

  const handleKey = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      onCancel();
      return;
    }
    if (e.key !== 'Tab') return;
    const controls = [...(dialogRef.current?.querySelectorAll<HTMLElement>('button:not(:disabled), input') ?? [])];
    const first = controls[0];
    const last = controls.at(-1);
    if (e.shiftKey && document.activeElement === first) {
      e.preventDefault();
      last?.focus();
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault();
      first?.focus();
    }
  };

  if (!open) return null;

  const canConfirm = requireInput ? inputValue === requireInput : true;
  const isDanger = variant === 'danger';

  return (
    <div
      ref={actionSurfaceRef}
      className="fixed inset-0 bg-[var(--console-overlay-backdrop)] backdrop-blur-sm flex items-center justify-center z-[100]"
      onClick={onCancel}
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        onKeyDown={handleKey}
        className="bg-cafe-surface rounded-xl shadow-xl p-6 max-w-sm w-full mx-4"
        onClick={(e) => e.stopPropagation()}
      >
        <h3 id={titleId} className="text-base font-semibold mb-2">
          {title}
        </h3>
        <p className="text-sm text-cafe-secondary mb-4 whitespace-pre-wrap">{message}</p>
        {requireInput && (
          <input
            ref={inputRef}
            type="text"
            value={inputValue}
            onChange={(e) => setInputValue(e.target.value)}
            placeholder={inputPlaceholder}
            className="w-full border border-cafe rounded-lg px-3 py-2 text-sm mb-4 focus:outline-none focus:ring-2 focus:ring-[var(--semantic-info)]"
          />
        )}
        <div className="flex justify-end gap-2">
          <button
            ref={cancelRef}
            type="button"
            onClick={onCancel}
            className="px-4 py-2 text-sm text-cafe-secondary hover:bg-cafe-surface-elevated rounded-lg transition-colors"
          >
            {cancelLabel}
          </button>
          <button
            type="button"
            onClick={onConfirm}
            disabled={!canConfirm}
            className={`px-4 py-2 text-sm text-[var(--cafe-surface)] rounded-lg transition-colors disabled:opacity-40 disabled:cursor-not-allowed ${
              isDanger ? 'bg-semantic-critical hover:opacity-90' : 'bg-semantic-info hover:opacity-90'
            }`}
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
