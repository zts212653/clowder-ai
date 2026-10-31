'use client';

import { type ReactNode, useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useActionOwnerReset, useActionSurfaceRef } from '../message-v2/message-action-ownership';
import { useShellCopy } from '../shell/shell-copy';
import { useShellPresentation } from '../shell/shell-presentation';
import { helpTipCopy } from './help-tip.shell-copy';

/** Concept explanations can be read on hover/focus or pinned by click/touch. */
export function HelpTip({
  topic,
  children,
  trigger,
  triggerClassName,
}: {
  topic: string;
  children: ReactNode;
  trigger?: ReactNode;
  triggerClassName?: string;
}) {
  const localized = useShellCopy(helpTipCopy);
  const copy = useShellPresentation() === 'v2' ? localized : helpTipCopy.zh;
  const id = useId();
  const button = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const ownedPanel = useActionSurfaceRef<HTMLDivElement>(undefined, undefined, panel);
  const hoverTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const suppressFocus = useRef(false);
  const [mode, setMode] = useState<'closed' | 'transient' | 'pinned'>('closed');
  const [position, setPosition] = useState<{ left: number; top: number } | null>(null);
  const open = mode !== 'closed';
  const clearHover = useCallback(() => {
    if (hoverTimer.current !== null) clearTimeout(hoverTimer.current);
    hoverTimer.current = null;
  }, []);
  const close = useCallback(() => {
    clearHover();
    setMode('closed');
  }, [clearHover]);
  useActionOwnerReset(close, undefined, undefined, true);
  useEffect(() => clearHover, [clearHover]);
  const contains = useCallback(
    (target: EventTarget | null) =>
      target instanceof Node && Boolean(button.current?.contains(target) || panel.current?.contains(target)),
    [],
  );
  const closeAndFocus = useCallback(() => {
    suppressFocus.current = true;
    close();
    button.current?.focus({ preventScroll: true });
    suppressFocus.current = false;
  }, [close]);
  useEffect(() => {
    if (!open) return;
    const outside = (event: PointerEvent) => {
      if (!contains(event.target)) close();
    };
    const onEscape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.stopPropagation();
      closeAndFocus();
    };
    document.addEventListener('pointerdown', outside);
    document.addEventListener('keydown', onEscape, true);
    return () => {
      document.removeEventListener('pointerdown', outside);
      document.removeEventListener('keydown', onEscape, true);
    };
  }, [open, close, closeAndFocus, contains]);
  useLayoutEffect(() => {
    if (!open) {
      setPosition(null);
      return;
    }
    const place = () => {
      if (!button.current || !panel.current) return;
      const anchor = button.current.getBoundingClientRect();
      const rect = panel.current.getBoundingClientRect();
      const top =
        anchor.bottom + 8 + rect.height <= window.innerHeight - 16 ? anchor.bottom + 8 : anchor.top - rect.height - 8;
      setPosition({
        left: Math.max(16, Math.min(anchor.left, window.innerWidth - rect.width - 16)),
        top: Math.max(16, top),
      });
    };
    place();
    window.addEventListener('resize', place);
    window.addEventListener('scroll', place, true);
    return () => {
      window.removeEventListener('resize', place);
      window.removeEventListener('scroll', place, true);
    };
  }, [open]);

  return (
    <span
      className="inline-flex items-center"
      onPointerEnter={(event) => {
        if (event.pointerType === 'touch' || open) return;
        clearHover();
        hoverTimer.current = setTimeout(() => setMode('transient'), 150);
      }}
      onPointerLeave={(event) => {
        if (contains(event.relatedTarget)) return;
        clearHover();
        if (mode === 'transient' && document.activeElement !== button.current)
          hoverTimer.current = setTimeout(close, 150);
      }}
      onBlur={(event) => {
        if (!contains(event.relatedTarget) && mode === 'transient') close();
      }}
    >
      <button
        ref={button}
        type="button"
        aria-label={copy.about(topic)}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls={open ? id : undefined}
        aria-describedby={open ? `${id}-text` : undefined}
        className={
          trigger
            ? triggerClassName
            : 'inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-full border border-cafe-subtle text-xs text-cafe-muted hover:text-cafe focus-visible:outline focus-visible:outline-2 focus-visible:outline-cafe-accent'
        }
        onFocus={() => {
          if (!suppressFocus.current) {
            clearHover();
            setMode((m) => (m === 'pinned' ? m : 'transient'));
          }
        }}
        onClick={() => {
          clearHover();
          setMode((m) => (m === 'pinned' ? 'closed' : 'pinned'));
        }}
      >
        {trigger ?? <span aria-hidden="true">?</span>}
      </button>
      {open &&
        typeof document !== 'undefined' &&
        createPortal(
          <div
            ref={ownedPanel}
            id={id}
            role="dialog"
            aria-label={copy.about(topic)}
            onPointerEnter={clearHover}
            onPointerLeave={(event) => {
              if (!contains(event.relatedTarget) && mode === 'transient' && document.activeElement !== button.current)
                hoverTimer.current = setTimeout(close, 150);
            }}
            className="fixed z-[100] max-h-[calc(100vh-32px)] overflow-auto rounded-lg border border-cafe-subtle bg-cafe-surface-elevated p-3 text-xs leading-relaxed text-cafe-secondary shadow-lg"
            style={{
              width: 'min(320px, calc(100vw - 32px))',
              left: position?.left ?? 16,
              top: position?.top ?? 16,
              visibility: position ? 'visible' : 'hidden',
            }}
          >
            <div className="flex items-start gap-2">
              <div id={`${id}-text`} className="min-w-0 flex-1 whitespace-pre-line break-words">
                {children}
              </div>
              <button
                type="button"
                aria-label={copy.close}
                className="h-6 w-6 shrink-0 rounded text-cafe-muted hover:text-cafe"
                onClick={closeAndFocus}
              >
                ×
              </button>
            </div>
          </div>,
          document.body,
        )}
    </span>
  );
}
