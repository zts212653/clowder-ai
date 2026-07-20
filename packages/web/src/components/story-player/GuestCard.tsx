'use client';

/**
 * F252 AC-E6 — Guest Card (客串卡片)
 *
 * Shows a dotted gold border card that slides in when a cross-feature
 * interaction is detected during replay. Auto-fades 2s after appearing.
 *
 * Visual spec:
 * - Dotted gold border (2px dashed)
 * - Slide-in from right (CSS animation)
 * - Fade-out transition after 2s
 * - Shows cat identifier + content snippet
 */

// biome-ignore lint/correctness/noUnusedImports: React in scope needed for renderToStaticMarkup in tests
import React, { useEffect, useRef, useState } from 'react';
import { useCatNameResolver } from '@/hooks/useCatNameResolver';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const FADE_DELAY_MS = 2000;
/** CSS opacity transition duration — onFadeComplete fires after this so parent doesn't unmount mid-transition */
export const FADE_TRANSITION_MS = 300;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface GuestCardProps {
  /** Target thread ID (outside current feature) */
  targetThreadId: string;
  /** Truncated content preview */
  contentSnippet: string;
  /** Cat that initiated the cross-feature interaction */
  catId?: string;
  /** Whether the card should be visible */
  visible: boolean;
  /** Callback when fade-out completes */
  onFadeComplete?: () => void;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function GuestCard({ contentSnippet, catId, visible, onFadeComplete }: GuestCardProps) {
  const resolveCatName = useCatNameResolver();
  const [fading, setFading] = useState(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Start fade timer when visible, reset on content change.
  // contentSnippet is intentionally in deps to reset timer for new cross-feature events.
  // biome-ignore lint/correctness/useExhaustiveDependencies: contentSnippet triggers timer reset for new events
  useEffect(() => {
    if (!visible) return;

    setFading(false);

    // Clear existing timer
    if (timerRef.current) {
      clearTimeout(timerRef.current);
    }

    // Phase 1: Start CSS opacity transition after FADE_DELAY_MS
    timerRef.current = setTimeout(() => {
      setFading(true);
      // Phase 2: Notify parent after CSS transition completes (FADE_TRANSITION_MS)
      // This prevents unmount before the opacity animation finishes.
      timerRef.current = setTimeout(() => {
        onFadeComplete?.();
      }, FADE_TRANSITION_MS);
    }, FADE_DELAY_MS);

    return () => {
      if (timerRef.current) {
        clearTimeout(timerRef.current);
        timerRef.current = null;
      }
    };
  }, [visible, contentSnippet, onFadeComplete]);

  if (!visible) return null;

  return (
    <>
      <style>{`
        @keyframes guestCardSlideIn {
          from { opacity: 0; transform: translateX(20px); }
          to { opacity: 1; transform: translateX(0); }
        }
      `}</style>
      <div
        data-testid="guest-card"
        className={`guest-card ${fading ? 'guest-card--fading' : ''}`}
        style={{
          border: '2px dashed var(--guest-card-border, #DAA520)',
          borderRadius: '8px',
          padding: '8px 12px',
          backgroundColor: 'var(--guest-card-bg, rgba(218, 165, 32, 0.08))',
          animation: 'guestCardSlideIn 0.3s ease-out',
          opacity: fading ? 0 : 1,
          transition: 'opacity 0.3s ease-out',
          pointerEvents: 'none',
          maxWidth: '320px',
        }}
      >
        <div
          style={{
            fontSize: 'var(--console-font-micro)',
            fontWeight: 600,
            color: 'var(--guest-card-label, #DAA520)',
            marginBottom: '4px',
            display: 'flex',
            alignItems: 'center',
            gap: '4px',
          }}
        >
          <span>→ 跨 Feature 传球</span>
          {catId && (
            <span
              style={{
                fontWeight: 400,
                opacity: 0.7,
              }}
            >
              · {resolveCatName(catId)}
            </span>
          )}
        </div>
        {contentSnippet && (
          <div
            style={{
              fontSize: 'var(--console-font-xs)',
              color: 'var(--guest-card-text, var(--text-secondary))',
              lineHeight: 1.4,
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              display: '-webkit-box',
              WebkitLineClamp: 2,
              WebkitBoxOrient: 'vertical',
            }}
          >
            {contentSnippet}
          </div>
        )}
      </div>
    </>
  );
}
