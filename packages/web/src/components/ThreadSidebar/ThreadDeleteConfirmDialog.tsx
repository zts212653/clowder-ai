'use client';

import { useEffect, useId, useRef, useState } from 'react';
import type { SidebarSnapshotRow } from '@/stores/sidebarProjectionStore';
import { useShellCopy } from '../shell/shell-copy';
import { threadDeletionCopy } from './thread-deletion.shell-copy';

export function ThreadDeleteConfirmDialog({
  thread,
  onCancel,
  onConfirm,
}: {
  thread: SidebarSnapshotRow;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const copy = useShellCopy(threadDeletionCopy);
  const isSystem = thread.isHubThread || !!thread.systemKind;
  const title = thread.title ?? copy.unnamed;
  const [typedName, setTypedName] = useState('');
  const confirmed = !isSystem || typedName === title;
  const headingId = useId();
  const dialogRef = useRef<HTMLDivElement>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    const previous = document.activeElement;
    (isSystem ? inputRef.current : cancelRef.current)?.focus();
    return () => {
      if (previous instanceof HTMLElement) previous.focus();
    };
  }, [isSystem]);

  return (
    <div
      role="presentation"
      className="fixed inset-0 z-[100] flex items-center justify-center bg-[var(--console-overlay-medium)] backdrop-blur-sm"
      onClick={onCancel}
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={headingId}
        className="bg-cafe-surface rounded-xl shadow-2xl p-5 max-w-sm w-full mx-4"
        onClick={(event) => event.stopPropagation()}
        onKeyDown={(event) => {
          if (event.key === 'Escape') {
            event.stopPropagation();
            onCancel();
          }
          if (event.key !== 'Tab') return;
          const controls = dialogRef.current?.querySelectorAll<HTMLElement>(
            'button:not(:disabled), input:not(:disabled)',
          );
          const first = controls?.[0];
          const last = controls?.[controls.length - 1];
          if (event.shiftKey && document.activeElement === first) {
            event.preventDefault();
            last?.focus();
          }
          if (!event.shiftKey && document.activeElement === last) {
            event.preventDefault();
            first?.focus();
          }
        }}
      >
        <h3 id={headingId} className="text-base font-bold text-cafe mb-2">
          {isSystem ? copy.systemTitle : copy.dialogTitle}
        </h3>
        <p className="text-sm text-cafe-secondary mb-1">{copy.deleting(title)}</p>
        {isSystem ? (
          <>
            <p className="text-xs text-conn-red-text mb-2">{copy.systemWarning}</p>
            <label className="block text-xs text-cafe-secondary mb-2">
              {copy.typeName}
              <input
                ref={inputRef}
                value={typedName}
                onChange={(event) => setTypedName(event.target.value)}
                placeholder={title}
                className="mt-2 w-full px-2.5 py-1.5 text-xs rounded-lg border border-cafe focus:outline-none focus:border-conn-red-ring mb-4"
              />
            </label>
          </>
        ) : (
          <p className="text-xs text-cafe-secondary mb-4">{copy.trashNote}</p>
        )}
        <div className="flex gap-2 justify-end">
          <button
            ref={cancelRef}
            type="button"
            onClick={onCancel}
            className="px-3 py-1.5 text-sm rounded-lg border border-cafe hover:bg-cafe-surface-elevated transition-colors"
          >
            {copy.cancel}
          </button>
          <button
            type="button"
            onClick={onConfirm}
            disabled={!confirmed}
            className={`px-3 py-1.5 text-sm rounded-lg text-[var(--cafe-surface)] transition-colors ${isSystem ? 'bg-conn-red-text hover:bg-conn-red-hover disabled:bg-conn-red-ring disabled:cursor-not-allowed' : 'bg-conn-amber-text hover:bg-conn-amber-hover'}`}
          >
            {isSystem ? copy.confirm : copy.moveToTrash}
          </button>
        </div>
      </div>
    </div>
  );
}
