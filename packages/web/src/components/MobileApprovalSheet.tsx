'use client';

import { useEffect, useRef } from 'react';
import { ApprovalPanel } from './ApprovalPanel';

interface MobileApprovalSheetProps {
  open: boolean;
  onClose: () => void;
}

export function MobileApprovalSheet({ open, onClose }: MobileApprovalSheetProps) {
  const closeButtonRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!open) return;
    closeButtonRef.current?.focus();
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [onClose, open]);

  if (!open) return null;

  return (
    <section
      role="dialog"
      aria-modal="true"
      aria-label="Needs Me"
      className="fixed inset-0 z-50 flex min-h-0 flex-col bg-cafe-surface lg:hidden"
      data-testid="mobile-approval-sheet"
    >
      <header className="flex items-center justify-between border-b border-cafe-subtle/40 px-4 pb-3 pt-[max(0.75rem,env(safe-area-inset-top))]">
        <h2 className="text-base font-semibold text-cafe">Needs Me</h2>
        <button
          ref={closeButtonRef}
          type="button"
          onClick={onClose}
          className="flex h-10 w-10 items-center justify-center rounded-lg text-cafe-secondary hover:bg-[var(--console-hover-bg)]"
          aria-label="关闭 Needs Me"
        >
          <svg aria-hidden="true" className="h-5 w-5" viewBox="0 0 20 20" fill="currentColor">
            <path
              fillRule="evenodd"
              d="M4.293 4.293a1 1 0 011.414 0L10 8.586l4.293-4.293a1 1 0 111.414 1.414L11.414 10l4.293 4.293a1 1 0 01-1.414 1.414L10 11.414l-4.293 4.293a1 1 0 01-1.414-1.414L8.586 10 4.293 5.707a1 1 0 010-1.414z"
              clipRule="evenodd"
            />
          </svg>
        </button>
      </header>
      <div className="flex min-h-0 flex-1 pb-[env(safe-area-inset-bottom)]">
        <ApprovalPanel />
      </div>
    </section>
  );
}
