import type { ReactNode, RefObject } from 'react';
import { createPortal } from 'react-dom';
import styles from './search-group-picker.module.css';

export function SearchGroupOverlay({
  children,
  pending,
  onClose,
  focusRoot,
}: {
  children: ReactNode;
  pending: boolean;
  onClose: () => void;
  focusRoot: RefObject<HTMLElement | null>;
}) {
  return createPortal(
    <div
      className={styles.overlay}
      role="presentation"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget && !pending) onClose();
      }}
      onKeyDown={(event) => {
        if (event.key === 'Escape' && !pending) {
          event.stopPropagation();
          onClose();
        }
        if (event.key !== 'Tab') return;
        const controls = [
          ...(focusRoot.current?.querySelectorAll<HTMLElement>(
            'button:not(:disabled), input:not(:disabled), select:not(:disabled)',
          ) ?? []),
        ];
        if (event.shiftKey && document.activeElement === controls[0]) {
          event.preventDefault();
          controls.at(-1)?.focus();
        } else if (!event.shiftKey && document.activeElement === controls.at(-1)) {
          event.preventDefault();
          controls[0]?.focus();
        }
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label="批量整理 Group"
        data-testid="search-group-editor"
        className={styles.editor}
      >
        {children}
      </div>
    </div>,
    document.body,
  );
}
