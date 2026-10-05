'use client';

/**
 * F322 AppTooltip — the one hover/focus name tip for shell controls (DESIGN.md "图标与悬停提示").
 *
 *  - Pointer: appears ~150ms after the pointer settles; once one tip has been shown, moving to an
 *    adjacent control shows the next tip with no extra wait (native `title` waits ~1s and can't be tuned).
 *  - Keyboard: keyboard focus (`:focus-visible`) shows the tip immediately; mouse-click focus does not.
 *  - Escape dismisses it (WCAG 1.4.13); the pointer may move onto the tip without it disappearing.
 *  - Touch: a long press shows the tip (the following tap is swallowed so it doesn't also act).
 *  - The tip is an aid, never the only name: callers still give the control its own `aria-label`,
 *    and never a native `title` (this component never sets one, so there's no double pop).
 *
 * The wrapper is `display: contents`, so it adds no layout box; the tip anchors to the wrapped control.
 */

import {
  type FocusEvent,
  type ReactElement,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
  type PointerEvent as ReactPointerEvent,
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
} from 'react';
import { createPortal } from 'react-dom';

export type AppTooltipSide = 'right' | 'bottom' | 'top';

/** Pointer settle time before the first tip of a run. */
export const APP_TOOLTIP_DELAY_MS = 150;
/** After a tip closes, moving to a neighbour within this window shows it instantly. */
export const APP_TOOLTIP_WARM_MS = 500;
/** Grace to travel from the control onto the tip itself without it closing. */
const HIDE_GRACE_MS = 120;
const LONG_PRESS_MS = 450;
const TOUCH_AUTOHIDE_MS = 2200;
const GAP_PX = 8;
const VIEWPORT_PAD_PX = 8;

/**
 * Shared across instances so "adjacent control = no re-wait" works: while any tip is open, or for a moment after
 * one closed, the next control's tip is instant. Only one tip is ever visible — opening one closes the previous.
 */
const warm: { until: number; active: { close: () => void } | null } = { until: 0, active: null };
export function resetAppTooltipWarmState(): void {
  warm.until = 0;
  warm.active = null;
}

interface AppTooltipProps {
  /** The control's name. Keep it short; it is also what a screen reader should hear on the control. */
  label: string;
  /** Optional second line (state / count / unavailable reason). */
  detail?: ReactNode;
  /** A real keyboard binding only; never an aspirational one. */
  shortcut?: string;
  side?: AppTooltipSide;
  /** Suppress the tip without unmounting the control (e.g. while its own menu is open). */
  disabled?: boolean;
  /**
   * For long text that must stay recoverable (a full conversation title, a roster): wrap instead of the
   * single 28px bar, and put the detail on its own lines. Everything else stays one line.
   */
  multiline?: boolean;
  children: ReactElement;
}

function matchesFocusVisible(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) return true;
  try {
    return target.matches(':focus-visible');
  } catch {
    return true;
  }
}

export function AppTooltip({
  label,
  detail,
  shortcut,
  side = 'right',
  disabled = false,
  multiline = false,
  children,
}: AppTooltipProps) {
  const id = useId();
  const wrapperRef = useRef<HTMLSpanElement>(null);
  const tipRef = useRef<HTMLDivElement>(null);
  const showTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const hideTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const longPressTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const touchHideTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const swallowClick = useRef(false);
  const dismissed = useRef(false);
  const [open, setOpen] = useState(false);
  const [position, setPosition] = useState<{ left: number; top: number } | null>(null);

  const clearTimers = useCallback(() => {
    for (const ref of [showTimer, hideTimer, longPressTimer, touchHideTimer]) {
      if (ref.current) clearTimeout(ref.current);
      ref.current = null;
    }
  }, []);

  const self = useRef<{ close: () => void }>({ close: () => {} });

  const close = useCallback(() => {
    clearTimers();
    if (warm.active === self.current) {
      warm.active = null;
      warm.until = Date.now() + APP_TOOLTIP_WARM_MS;
    }
    setOpen(false);
    setPosition(null);
  }, [clearTimers]);
  self.current.close = close;

  const openNow = useCallback(() => {
    if (disabled || dismissed.current) return;
    clearTimers();
    if (warm.active && warm.active !== self.current) warm.active.close();
    warm.active = self.current;
    setOpen(true);
  }, [clearTimers, disabled]);

  const scheduleOpen = useCallback(() => {
    if (disabled || dismissed.current) return;
    if (hideTimer.current) clearTimeout(hideTimer.current);
    hideTimer.current = null;
    if (showTimer.current) clearTimeout(showTimer.current);
    const wait = warm.active !== null || Date.now() < warm.until ? 0 : APP_TOOLTIP_DELAY_MS;
    if (wait === 0) {
      openNow();
      return;
    }
    showTimer.current = setTimeout(openNow, wait);
  }, [disabled, openNow]);

  const scheduleClose = useCallback(() => {
    if (showTimer.current) clearTimeout(showTimer.current);
    showTimer.current = null;
    if (hideTimer.current) clearTimeout(hideTimer.current);
    hideTimer.current = setTimeout(close, HIDE_GRACE_MS);
  }, [close]);

  useEffect(
    () => () => {
      clearTimers();
      if (warm.active === self.current) warm.active = null;
    },
    [clearTimers],
  );

  useEffect(() => {
    if (disabled) close();
  }, [disabled, close]);

  // Escape dismisses while open (keyboard or hover).
  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      dismissed.current = true;
      close();
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [open, close]);

  // Place next to the control, flipped/clamped to stay inside the viewport.
  useLayoutEffect(() => {
    if (!open) return;
    const place = () => {
      const anchor = wrapperRef.current?.firstElementChild as HTMLElement | null;
      const tip = tipRef.current;
      if (!anchor || !tip) return;
      const a = anchor.getBoundingClientRect();
      const t = tip.getBoundingClientRect();
      let left: number;
      let top: number;
      if (side === 'right') {
        left = a.right + GAP_PX;
        top = a.top + (a.height - t.height) / 2;
        if (left + t.width > window.innerWidth - VIEWPORT_PAD_PX) left = a.left - GAP_PX - t.width;
      } else {
        left = a.left + (a.width - t.width) / 2;
        top = side === 'bottom' ? a.bottom + GAP_PX : a.top - GAP_PX - t.height;
        if (side === 'bottom' && top + t.height > window.innerHeight - VIEWPORT_PAD_PX) top = a.top - GAP_PX - t.height;
        if (side === 'top' && top < VIEWPORT_PAD_PX) top = a.bottom + GAP_PX;
      }
      setPosition({
        left: Math.max(VIEWPORT_PAD_PX, Math.min(left, window.innerWidth - t.width - VIEWPORT_PAD_PX)),
        top: Math.max(VIEWPORT_PAD_PX, Math.min(top, window.innerHeight - t.height - VIEWPORT_PAD_PX)),
      });
    };
    place();
    window.addEventListener('resize', place);
    window.addEventListener('scroll', place, true);
    return () => {
      window.removeEventListener('resize', place);
      window.removeEventListener('scroll', place, true);
    };
  }, [open, side]);

  const onPointerEnter = (event: ReactPointerEvent) => {
    if (event.pointerType === 'touch') return;
    scheduleOpen();
  };
  const onPointerLeave = (event: ReactPointerEvent) => {
    if (event.pointerType === 'touch') return;
    dismissed.current = false;
    scheduleClose();
  };
  const onPointerDown = (event: ReactPointerEvent) => {
    if (event.pointerType === 'touch') {
      swallowClick.current = false;
      if (longPressTimer.current) clearTimeout(longPressTimer.current);
      longPressTimer.current = setTimeout(() => {
        swallowClick.current = true;
        openNow();
        touchHideTimer.current = setTimeout(close, TOUCH_AUTOHIDE_MS);
      }, LONG_PRESS_MS);
      return;
    }
    // A click is the user acting on the control; the name tip has done its job.
    close();
  };
  const cancelLongPress = (event: ReactPointerEvent) => {
    if (event.pointerType !== 'touch') return;
    if (longPressTimer.current) clearTimeout(longPressTimer.current);
    longPressTimer.current = null;
  };
  const onClickCapture = (event: { stopPropagation: () => void; preventDefault: () => void }) => {
    if (!swallowClick.current) return;
    swallowClick.current = false;
    event.stopPropagation();
    event.preventDefault();
  };
  const onFocus = (event: FocusEvent) => {
    if (!matchesFocusVisible(event.target)) return;
    dismissed.current = false;
    openNow();
  };
  const onBlur = (event: FocusEvent) => {
    if (wrapperRef.current?.contains(event.relatedTarget as Node | null)) return;
    dismissed.current = false;
    close();
  };
  const onKeyDownCapture = (event: ReactKeyboardEvent) => {
    if (event.key === 'Escape' && open) {
      dismissed.current = true;
      close();
    }
  };

  return (
    <span
      ref={wrapperRef}
      style={{ display: 'contents' }}
      onPointerEnter={onPointerEnter}
      onPointerLeave={onPointerLeave}
      onPointerDownCapture={onPointerDown}
      onPointerUp={cancelLongPress}
      onPointerCancel={cancelLongPress}
      onClickCapture={onClickCapture}
      onFocusCapture={onFocus}
      onBlurCapture={onBlur}
      onKeyDownCapture={onKeyDownCapture}
    >
      {children}
      {open &&
        typeof document !== 'undefined' &&
        createPortal(
          <div
            ref={tipRef}
            id={id}
            role="tooltip"
            data-testid="app-tooltip"
            data-side={side}
            className={`pointer-events-auto fixed z-[100] flex max-w-[320px] rounded-lg px-2.5 text-xs font-medium ${
              multiline ? 'flex-col items-start py-1.5 leading-[1.5]' : 'items-center'
            }`}
            style={{
              left: position?.left ?? 0,
              top: position?.top ?? 0,
              visibility: position ? 'visible' : 'hidden',
              ...(multiline ? { minHeight: 28 } : { height: 28 }),
              background: 'var(--shell-tip-bg, var(--cafe-text))',
              color: 'var(--shell-tip-fg, var(--cafe-surface-canvas))',
              boxShadow: 'var(--shell-tip-shadow, 0 4px 10px rgb(20 20 19 / 0.1))',
            }}
            onPointerEnter={() => {
              if (hideTimer.current) clearTimeout(hideTimer.current);
              hideTimer.current = null;
            }}
            onPointerLeave={scheduleClose}
          >
            <span className={multiline ? 'break-words' : 'whitespace-nowrap'}>
              {label}
              {detail && !multiline ? <span className="ml-1.5 font-normal opacity-70">{detail}</span> : null}
              {shortcut ? <kbd className="ml-2 font-sans text-xs opacity-70">{shortcut}</kbd> : null}
            </span>
            {detail && multiline ? (
              <span className="block whitespace-pre-line break-words font-normal opacity-75">{detail}</span>
            ) : null}
          </div>,
          document.body,
        )}
    </span>
  );
}
