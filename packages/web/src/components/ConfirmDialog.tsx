'use client';

import { useEffect, useRef, useState } from 'react';

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
  onConfirm,
  onCancel,
}: ConfirmDialogProps) {
  const [inputValue, setInputValue] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);
  const confirmBtnRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (open) {
      setInputValue('');
      if (requireInput) setTimeout(() => inputRef.current?.focus(), 50);
      else setTimeout(() => confirmBtnRef.current?.focus(), 50);
    }
  }, [open, requireInput]);

  useEffect(() => {
    if (!open) return;
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onCancel();
    };
    window.addEventListener('keydown', handleKey);
    return () => window.removeEventListener('keydown', handleKey);
  }, [open, onCancel]);

  if (!open) return null;

  const canConfirm = requireInput ? inputValue === requireInput : true;
  const isDanger = variant === 'danger';

  return (
    <div
      className="fixed inset-0 bg-[var(--console-overlay-backdrop)] flex items-center justify-center z-[100]"
      onClick={onCancel}
    >
      <div
        className="bg-cafe-surface rounded-xl border border-[var(--cafe-border)] shadow-xl p-6 max-w-sm w-full mx-4"
        onClick={(e) => e.stopPropagation()}
      >
        <h3 className="text-base font-semibold mb-2">{title}</h3>
        <p className="text-sm text-cafe-secondary mb-4 whitespace-pre-wrap">{message}</p>
        {requireInput && (
          <input
            ref={inputRef}
            type="text"
            value={inputValue}
            onChange={(e) => setInputValue(e.target.value)}
            placeholder={inputPlaceholder}
            className="w-full border border-[var(--console-border-soft)] rounded-lg px-3 py-2 text-sm mb-4 focus:outline-none focus:ring-2 focus:ring-conn-sky-ring"
          />
        )}
        <div className="flex justify-end gap-2">
          <button
            onClick={onCancel}
            className="px-4 py-2 text-sm text-cafe-secondary hover:bg-cafe-surface-elevated rounded-lg transition-colors"
          >
            {cancelLabel}
          </button>
          <button
            ref={confirmBtnRef}
            onClick={onConfirm}
            disabled={!canConfirm}
            className={`px-4 py-2 text-sm text-[var(--cafe-surface)] rounded-lg transition-colors focus:outline-none focus:ring-2 disabled:opacity-40 disabled:cursor-not-allowed ${
              isDanger
                ? 'bg-conn-red-text hover:opacity-90 focus:ring-conn-red-ring'
                : 'bg-[var(--cafe-accent)] hover:opacity-90 focus:ring-[var(--cafe-accent)]/40'
            }`}
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
