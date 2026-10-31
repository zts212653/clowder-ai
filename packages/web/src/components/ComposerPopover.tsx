'use client';

import { type ReactNode, type RefObject, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

export function composerPopoverPosition(
  rect: { top: number; left: number },
  width: number,
  height: number,
  preferredWidth = 300,
) {
  const panelWidth = Math.min(preferredWidth, width - 16);
  return {
    position: 'fixed' as const,
    width: panelWidth,
    left: Math.max(8, Math.min(rect.left, width - panelWidth - 8)),
    bottom: Math.max(8, height - rect.top + 6),
    maxHeight: Math.max(64, Math.min(rect.top - 14, height - 16)),
  };
}

export function composerViewportPosition(rect: { left: number }, width: number, height: number, preferredWidth = 560) {
  if (width < 640) return { position: 'fixed' as const, inset: 0, width: '100%', height, maxHeight: height };
  const panelWidth = Math.min(preferredWidth, width - 32);
  return {
    position: 'fixed' as const,
    width: panelWidth,
    left: Math.max(16, Math.min(rect.left, width - panelWidth - 16)),
    top: 16,
    bottom: 16,
    height: height - 32,
    maxHeight: height - 32,
  };
}

function readViewport() {
  if (typeof window === 'undefined') return { width: 0, height: 0 };
  return { width: window.innerWidth, height: window.visualViewport?.height ?? window.innerHeight };
}

function readAnchorGeometry(trigger: HTMLButtonElement) {
  const rect = trigger.getBoundingClientRect();
  const style = getComputedStyle(trigger);
  return {
    x: rect.left + rect.width / 2,
    y: rect.top + rect.height / 2,
    width: trigger.offsetWidth,
    height: trigger.offsetHeight,
    visible:
      trigger.isConnected &&
      rect.width > 0 &&
      rect.height > 0 &&
      style.display !== 'none' &&
      style.visibility !== 'hidden',
  };
}

/** Shared composer controls use an anchor popup; import can opt into a viewport sheet. */
export function ComposerPopover({
  anchor,
  label,
  onClose,
  preferredWidth,
  presentation = 'v2',
  scrollContent = false,
  children,
}: {
  anchor: RefObject<HTMLButtonElement>;
  label: string;
  onClose: () => void;
  preferredWidth?: number;
  /** Let a child body scroll while a sibling action footer stays visible. */
  scrollContent?: boolean;
  /** A full-height mobile sheet / viewport-height desktop panel. Anchor consumers are unchanged. */
  presentation?: 'classic' | 'v2' | 'anchor' | 'viewport';
  children: ReactNode;
}) {
  const [viewport, setViewport] = useState(readViewport);
  const panel = useRef<HTMLDivElement>(null);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  useEffect(() => {
    const trigger = anchor.current;
    const initialAnchor = trigger ? readAnchorGeometry(trigger) : null;
    panel.current?.querySelector<HTMLElement>('button:not(:disabled), [tabindex="0"]')?.focus();
    const dismiss = (restoreFocus: boolean) => {
      closeRef.current();
      if (restoreFocus) trigger?.focus();
    };
    const pointer = (event: PointerEvent) => {
      if (!panel.current?.contains(event.target as Node) && !trigger?.contains(event.target as Node)) dismiss(false);
    };
    const key = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      dismiss(true);
    };
    const resize = () => (presentation === 'viewport' ? setViewport(readViewport()) : dismiss(true));
    const scroll = (event: Event) => {
      const current = trigger ? readAnchorGeometry(trigger) : null;
      if (!current?.visible || !initialAnchor) {
        dismiss(false);
        return;
      }
      if (event.target instanceof Node && panel.current?.contains(event.target)) return;
      // Add rotates in place on opening: its outer rect changes while its center and
      // layout size stay fixed. Half a CSS pixel tolerates browser transform rounding.
      if (
        Math.abs(current.x - initialAnchor.x) > 0.5 ||
        Math.abs(current.y - initialAnchor.y) > 0.5 ||
        current.width !== initialAnchor.width ||
        current.height !== initialAnchor.height
      )
        dismiss(false);
    };
    const blur = (event: FocusEvent) => {
      if (!panel.current?.contains(event.target as Node) && !trigger?.contains(event.target as Node)) dismiss(false);
    };
    document.addEventListener('pointerdown', pointer);
    document.addEventListener('keydown', key);
    document.addEventListener('focusin', blur);
    window.addEventListener('resize', resize);
    if (presentation === 'viewport') window.visualViewport?.addEventListener('resize', resize);
    window.addEventListener('scroll', scroll, true);
    return () => {
      document.removeEventListener('pointerdown', pointer);
      document.removeEventListener('keydown', key);
      document.removeEventListener('focusin', blur);
      window.removeEventListener('resize', resize);
      if (presentation === 'viewport') window.visualViewport?.removeEventListener('resize', resize);
      window.removeEventListener('scroll', scroll, true);
    };
  }, [anchor, presentation]);
  const trigger = anchor.current;
  if (!trigger) return null;
  return createPortal(
    <div
      ref={panel}
      role="dialog"
      aria-label={label}
      style={
        presentation === 'viewport'
          ? composerViewportPosition(trigger.getBoundingClientRect(), viewport.width, viewport.height, preferredWidth)
          : composerPopoverPosition(
              trigger.getBoundingClientRect(),
              window.innerWidth,
              window.innerHeight,
              preferredWidth,
            )
      }
      className={`z-[70] flex flex-col ${scrollContent ? 'overflow-hidden' : 'overflow-y-auto'} overscroll-contain ${
        presentation === 'classic'
          ? 'rounded-2xl bg-cafe-surface-canvas p-1.5 text-cafe-secondary shadow-xl'
          : `${presentation === 'viewport' ? 'rounded-t-xl sm:rounded-xl' : 'rounded-lg'} border border-[var(--shell-hairline-strong)] bg-[var(--shell-paper)] p-1 text-[var(--shell-body)] shadow-lg`
      }`}
    >
      {children}
    </div>,
    document.body,
  );
}
