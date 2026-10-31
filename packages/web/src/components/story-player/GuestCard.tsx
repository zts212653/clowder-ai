'use client';

/**
 * F252 AC-E6 — Guest Card (客串卡片)
 *
 * Shows a dotted gold border card that slides in when a cross-feature
 * interaction is detected during replay. The rich card compacts after 2s, but
 * its canonical-source link remains persistently keyboard-accessible.
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
/** CSS opacity transition duration before the card becomes a compact source link. */
export const FADE_TRANSITION_MS = 300;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface GuestCardProps {
  /** Target thread ID (outside current feature) */
  targetThreadId: string;
  /** Full content; the card clamps it visually and exposes the canonical thread. */
  contentSnippet: string;
  /** Cat that initiated the cross-feature interaction */
  catId?: string;
  /** Whether the card should be visible */
  visible: boolean;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function GuestCard({ targetThreadId, contentSnippet, catId, visible }: GuestCardProps) {
  const resolveCatName = useCatNameResolver();
  const [fading, setFading] = useState(false);
  const [compacted, setCompacted] = useState(false);
  const [interacting, setInteracting] = useState(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Start fade timer when visible, reset on content change.
  // contentSnippet is intentionally in deps to reset timer for new cross-feature events.
  // biome-ignore lint/correctness/useExhaustiveDependencies: contentSnippet triggers timer reset for new events
  useEffect(() => {
    if (!visible || interacting) return;

    setFading(false);
    setCompacted(false);

    // Clear existing timer
    if (timerRef.current) {
      clearTimeout(timerRef.current);
    }

    // Phase 1: Start CSS opacity transition after FADE_DELAY_MS
    timerRef.current = setTimeout(() => {
      setFading(true);
      // Phase 2: retire the rich card while preserving its canonical source jump.
      timerRef.current = setTimeout(() => {
        setCompacted(true);
        setFading(false);
      }, FADE_TRANSITION_MS);
    }, FADE_DELAY_MS);

    return () => {
      if (timerRef.current) {
        clearTimeout(timerRef.current);
        timerRef.current = null;
      }
    };
  }, [visible, contentSnippet, interacting]);

  if (!visible) return null;

  if (compacted) {
    return (
      <a
        data-testid="guest-card-canonical-link"
        href={`/thread/${encodeURIComponent(targetThreadId)}`}
        className="inline-flex rounded-lg border border-dashed border-cafe-accent bg-cafe-surface-elevated px-3 py-2 text-xs font-semibold text-cafe-accent shadow-sm hover:bg-cafe-accent/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cafe-accent"
      >
        打开跨 Feature 全文
      </a>
    );
  }

  return (
    <>
      <style>{`
        @keyframes guestCardSlideIn {
          from { opacity: 0; transform: translateX(20px); }
          to { opacity: 1; transform: translateX(0); }
        }
      `}</style>
      {/* biome-ignore lint/a11y/noStaticElementInteractions: hover/focus only pauses visual compaction; the canonical link owns interaction semantics */}
      <div
        data-testid="guest-card"
        className={`guest-card ${fading ? 'guest-card--fading' : ''}`}
        onMouseEnter={() => setInteracting(true)}
        onMouseLeave={() => setInteracting(false)}
        onFocusCapture={() => setInteracting(true)}
        onBlurCapture={(event) => {
          if (!event.currentTarget.contains(event.relatedTarget)) setInteracting(false);
        }}
        style={{
          border: '2px dashed var(--guest-card-border, #DAA520)',
          borderRadius: '8px',
          padding: '8px 12px',
          backgroundColor: 'var(--guest-card-bg, rgba(218, 165, 32, 0.08))',
          animation: 'guestCardSlideIn 0.3s ease-out',
          opacity: fading ? 0 : 1,
          transition: 'opacity 0.3s ease-out',
          pointerEvents: 'auto',
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
        <a
          href={`/thread/${encodeURIComponent(targetThreadId)}`}
          className="mt-2 inline-flex rounded px-2 py-1 text-xs font-semibold text-cafe-accent hover:bg-cafe-accent/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cafe-accent"
        >
          打开目标线程全文
        </a>
      </div>
    </>
  );
}
