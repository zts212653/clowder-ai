'use client';

import { type CSSProperties, type ReactNode, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useShellCopy } from '../shell/shell-copy';
import styles from './cat-profile-card.module.css';
import { catProfileCardCopy } from './cat-profile-card.shell-copy';

function cycleFocus(event: KeyboardEvent, panel: HTMLDivElement | null) {
  const buttons = Array.from(panel?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)') ?? []).filter(
    (node) => getComputedStyle(node).display !== 'none',
  );
  const first = buttons[0],
    last = buttons.at(-1);
  if (!first || !last || document.activeElement !== (event.shiftKey ? first : last)) return;
  event.preventDefault();
  (event.shiftKey ? last : first).focus();
}

export function CatProfileCardOverlay({
  anchor,
  label,
  suspended,
  onClose,
  children,
}: {
  anchor: HTMLElement;
  label: string;
  suspended: boolean;
  onClose(): void;
  children: ReactNode;
}) {
  const panel = useRef<HTMLDivElement>(null);
  const copy = useShellCopy(catProfileCardCopy);
  const close = useRef(onClose);
  const opener = useRef<HTMLElement | null>(null);
  close.current = onClose;
  const [position, setPosition] = useState({ mobile: false, left: 8, top: 8 });
  const [drag, setDrag] = useState(0);
  const dragStart = useRef<number | null>(null);
  useLayoutEffect(() => {
    const update = () => {
      const rect = anchor.getBoundingClientRect();
      const height = panel.current?.offsetHeight ?? 0;
      setPosition({
        mobile: window.innerWidth < 640,
        left: Math.max(8, Math.min(rect.left, window.innerWidth - 348)),
        top: Math.max(8, Math.min(rect.bottom + 8, window.innerHeight - height - 8)),
      });
    };
    update();
    const observer = new ResizeObserver(update);
    if (panel.current) observer.observe(panel.current);
    window.addEventListener('resize', update);
    return () => {
      observer.disconnect();
      window.removeEventListener('resize', update);
    };
  }, [anchor]);
  useLayoutEffect(() => {
    if (suspended) return;
    if (!opener.current)
      opener.current = anchor.contains(document.activeElement)
        ? (document.activeElement as HTMLElement)
        : anchor.querySelector('button');
    panel.current
      ?.querySelector<HTMLElement>('button:not(:disabled):not([data-cat-card-drag])')
      ?.focus({ preventScroll: true });
    const key = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.isComposing) return;
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        close.current();
        opener.current?.focus({ preventScroll: true });
      }
      if (event.key === 'Tab') cycleFocus(event, panel.current);
    };
    const outside = (event: Event) => {
      if (event.target instanceof Node && !panel.current?.contains(event.target) && !anchor.contains(event.target))
        close.current();
    };
    const scroll = (event: Event) => {
      if (window.innerWidth >= 640 && event.target instanceof Node && !panel.current?.contains(event.target))
        close.current();
    };
    document.addEventListener('keydown', key);
    document.addEventListener('pointerdown', outside);
    document.addEventListener('focusin', outside);
    window.addEventListener('scroll', scroll, true);
    return () => {
      document.removeEventListener('keydown', key);
      document.removeEventListener('pointerdown', outside);
      document.removeEventListener('focusin', outside);
      window.removeEventListener('scroll', scroll, true);
    };
  }, [anchor, suspended]);
  return createPortal(
    <div className="cafe-presentation" style={{ visibility: suspended ? 'hidden' : undefined }}>
      <div className={styles.backdrop} aria-hidden="true" />
      <div
        ref={panel}
        role="dialog"
        aria-label={label}
        aria-modal={position.mobile || undefined}
        aria-hidden={suspended || undefined}
        className={styles.card}
        style={
          {
            '--cat-card-left': `${position.left}px`,
            '--cat-card-top': `${position.top}px`,
            '--cat-card-drag': `${drag}px`,
          } as CSSProperties
        }
      >
        <button
          type="button"
          data-cat-card-drag
          aria-label={copy.close}
          className={styles.dragHandle}
          onClick={onClose}
          onPointerDown={(event) => {
            dragStart.current = event.clientY;
            event.currentTarget.setPointerCapture(event.pointerId);
          }}
          onPointerMove={(event) => {
            if (dragStart.current !== null) setDrag(Math.max(0, event.clientY - dragStart.current));
          }}
          onPointerUp={() => {
            if (drag > 60) onClose();
            setDrag(0);
            dragStart.current = null;
          }}
          onPointerCancel={() => {
            setDrag(0);
            dragStart.current = null;
          }}
        >
          <span />
        </button>
        {children}
      </div>
    </div>,
    document.body,
  );
}
