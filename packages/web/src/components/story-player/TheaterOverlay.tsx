'use client';

/**
 * F252 Phase E — Meow Theater Overlay
 *
 * Fullscreen portal overlay for thread-level replay. Renders on top of
 * the Hub using the same overlay pattern as ChatContainer's sidebar
 * overlay (fixed inset-0 + backdrop-blur-sm + z-index layering).
 *
 * operator iron rule: "100% 看起来就是你们平时的样子加特效和快进"
 * → This overlay wraps Hub-native message components, not custom replay UI.
 */

import { type ReactNode, useCallback, useEffect } from 'react';
import { createPortal } from 'react-dom';

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

interface TheaterOverlayProps {
  /** Whether the overlay is visible */
  open: boolean;
  /** Close handler (Escape key + backdrop click + close button) */
  onClose: () => void;
  /** Replay message list (rendered in scrollable area) */
  children: ReactNode;
  /** Playback controls (rendered in fixed bottom bar) */
  controls?: ReactNode;
  /** Thread title for the header */
  title?: string;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function TheaterOverlay({ open, onClose, children, controls, title }: TheaterOverlayProps) {
  // ── Escape key handler ──
  const handleKeyDown = useCallback(
    (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        onClose();
      }
    },
    [onClose],
  );

  useEffect(() => {
    if (!open) return;
    document.addEventListener('keydown', handleKeyDown);
    // Prevent body scroll when overlay is open
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.removeEventListener('keydown', handleKeyDown);
      document.body.style.overflow = prevOverflow;
    };
  }, [open, handleKeyDown]);

  if (!open) return null;

  return createPortal(
    <div
      className="fixed inset-0 z-[60] flex flex-col"
      role="dialog"
      aria-modal="true"
      aria-label={title ? `Replay: ${title}` : 'Thread replay'}
    >
      {/* Backdrop */}
      <div
        className="absolute inset-0 bg-[var(--console-overlay-backdrop,rgba(0,0,0,0.75))] backdrop-blur-md"
        onClick={onClose}
        aria-hidden="true"
      />

      {/* Content container — sits above backdrop */}
      <div className="relative z-10 flex flex-col h-full">
        {/* Header bar */}
        <div className="flex items-center justify-between px-4 py-3 border-b border-[var(--console-border,rgba(255,255,255,0.1))]">
          <div className="flex items-center gap-3">
            {/* Theater icon */}
            <svg
              width="20"
              height="20"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.5"
              strokeLinecap="round"
              strokeLinejoin="round"
              className="text-[var(--console-text-secondary)]"
              aria-hidden="true"
            >
              <path d="M7 4v16" />
              <path d="M17 4v16" />
              <path d="M3 8h4" />
              <path d="M17 8h4" />
              <path d="M3 12h18" />
              <path d="M3 16h4" />
              <path d="M17 16h4" />
            </svg>
            <span className="text-sm font-medium text-[var(--console-text-primary,#fff)]">
              {title || 'Thread Replay'}
            </span>
          </div>

          {/* Close button */}
          <button
            type="button"
            onClick={onClose}
            className="p-1.5 rounded-lg hover:bg-[var(--console-hover,rgba(255,255,255,0.08))] transition-colors"
            aria-label="Close replay"
          >
            <svg
              width="18"
              height="18"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
              className="text-[var(--console-text-secondary)]"
              aria-hidden="true"
            >
              <path d="M18 6 6 18" />
              <path d="m6 6 12 12" />
            </svg>
          </button>
        </div>

        {/* Scrollable message area */}
        <div className="flex-1 overflow-y-auto px-4 py-4">{children}</div>

        {/* Bottom controls bar */}
        {controls && (
          <div className="border-t border-[var(--console-border,rgba(255,255,255,0.1))] px-4 py-3 bg-[var(--console-shell-bg,#111)]">
            {controls}
          </div>
        )}
      </div>
    </div>,
    document.body,
  );
}
