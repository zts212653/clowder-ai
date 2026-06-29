'use client';

import { type ReactNode, useEffect } from 'react';

/**
 * Modal overlay with backdrop-click + Escape dismissal (F228 UX fix #1).
 * Clicking the dimmed backdrop or pressing Escape calls `onClose`; clicks inside
 * the panel are stopped from bubbling so they don't dismiss.
 */
export function ModalOverlay({
  onClose,
  children,
  maxWidthClass = 'max-w-xl',
}: {
  onClose: () => void;
  children: ReactNode;
  maxWidthClass?: string;
}) {
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div
      role="dialog"
      aria-modal="true"
      onClick={onClose}
      className="fixed inset-0 z-[100] flex items-center justify-center bg-[var(--console-overlay-backdrop)] p-4 backdrop-blur-sm"
    >
      <div
        onClick={(event) => event.stopPropagation()}
        className={`flex max-h-[calc(100vh-32px)] w-full ${maxWidthClass} flex-col overflow-hidden rounded-2xl border border-cafe bg-cafe-surface-elevated p-5 shadow-xl`}
      >
        {children}
      </div>
    </div>
  );
}
