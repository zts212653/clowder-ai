'use client';

import type { ReactNode } from 'react';
import { createPortal } from 'react-dom';
import type { CatData } from '@/hooks/useCatData';
import { useMemberText } from './editor-presentation';

/** Chat supplies a dialog host; the member form and save transaction belong to the shared editor. */
export function MemberEditorModal({
  cat,
  saving,
  onClose,
  children,
}: {
  cat: CatData;
  saving: boolean;
  onClose: () => Promise<void>;
  children: ReactNode;
}) {
  const t = useMemberText();
  return createPortal(
    <div
      className="fixed inset-0 z-[60] flex items-center justify-center bg-[var(--console-overlay-medium)] px-4 backdrop-blur-sm"
      data-bootcamp-host="cat-editor-modal"
      onClick={(event) => {
        if (event.target === event.currentTarget) void onClose();
      }}
    >
      <div
        className="member-editor-modal flex max-h-[88vh] w-full max-w-[720px] flex-col overflow-hidden rounded-[28px] bg-[var(--console-card-bg)] shadow-[0_22px_48px_rgba(43,33,26,0.13)]"
        role="dialog"
        aria-modal="true"
        aria-labelledby="member-editor-title"
        data-guide-id="member-editor.profile"
        data-bootcamp-step="cat-editor"
      >
        <div className="flex shrink-0 items-start justify-between px-7 py-5">
          <p id="member-editor-title" className="text-compact font-extrabold text-[var(--console-modal-title)]">
            {cat.displayName || cat.name || cat.id}
          </p>
          <button
            type="button"
            disabled={saving}
            onClick={() => void onClose()}
            aria-label={t('关闭成员窗口')}
            className="flex h-8 w-8 items-center justify-center rounded-[10px] bg-[var(--console-modal-close-bg)] text-lg font-extrabold leading-none text-[var(--console-modal-close-fg)] transition hover:opacity-80"
          >
            ×
          </button>
        </div>
        {children}
      </div>
    </div>,
    document.body,
  );
}
