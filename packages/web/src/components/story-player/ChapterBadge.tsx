/**
 * F252 Phase E PR E-3 — Chapter Milestone Badge
 *
 * Styled badge on the progress bar for chapter markers.
 * Kind-differentiated: pass_ball (golden glow), invocation (indigo),
 * post_idle (gray). Hover shows tooltip with label + relative time.
 */

'use client';

import { useState } from 'react';
import type { ChapterKind } from '@/lib/story-player/chapters';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface ChapterBadgeProps {
  kind: ChapterKind;
  label: string;
  icon: string;
  /** Position on progress bar (0-100 %) */
  position: number;
  /** Whether this badge is before/at current playback position */
  isPast: boolean;
  /** Formatted relative time string (e.g. "2:30") */
  relativeTime: string;
  onClick: () => void;
}

// ---------------------------------------------------------------------------
// Kind → color mapping
// ---------------------------------------------------------------------------

const KIND_COLORS: Record<ChapterKind, { bg: string; glow: string }> = {
  pass_ball: { bg: '#d4a017', glow: 'rgba(212, 160, 23, 0.5)' },
  invocation: { bg: '#6366f1', glow: 'rgba(99, 102, 241, 0.3)' },
  post_idle: { bg: '#6b7280', glow: 'rgba(107, 114, 128, 0.3)' },
  session_start: { bg: '#10b981', glow: 'rgba(16, 185, 129, 0.3)' },
  session_end: { bg: '#ef4444', glow: 'rgba(239, 68, 68, 0.3)' },
};

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function ChapterBadge({ kind, label, icon, position, isPast, relativeTime, onClick }: ChapterBadgeProps) {
  const [hovered, setHovered] = useState(false);
  const colors = KIND_COLORS[kind];

  return (
    <button
      type="button"
      data-chapter-kind={kind}
      aria-label={label}
      onClick={(e) => {
        e.stopPropagation();
        onClick();
      }}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      style={{
        position: 'absolute',
        left: `${position}%`,
        top: '-5px',
        width: '10px',
        height: '16px',
        transform: hovered ? 'translateX(-50%) scale(1.3)' : 'translateX(-50%)',
        background: isPast ? colors.bg : `${colors.bg}88`,
        border: 'none',
        borderRadius: '3px',
        cursor: 'pointer',
        zIndex: 3,
        boxShadow: isPast || hovered ? `0 0 ${hovered ? 10 : 6}px ${colors.glow}` : 'none',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: 0,
        fontSize: 'var(--console-font-micro)',
        transition: 'box-shadow 0.2s ease, transform 0.15s ease',
        color: 'inherit',
      }}
    >
      <span style={{ pointerEvents: 'none', lineHeight: 1 }}>{icon}</span>

      {/* Hover tooltip */}
      {hovered && (
        <div
          role="tooltip"
          style={{
            position: 'absolute',
            bottom: '100%',
            left: '50%',
            transform: 'translateX(-50%)',
            marginBottom: '6px',
            padding: '4px 8px',
            background: 'rgba(0, 0, 0, 0.9)',
            borderRadius: '4px',
            whiteSpace: 'nowrap',
            fontSize: 'var(--console-font-label)',
            color: '#e0e0e0',
            fontFamily: 'var(--font-mono, monospace)',
            pointerEvents: 'none',
            zIndex: 10,
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            gap: '2px',
            border: `1px solid ${colors.bg}44`,
          }}
        >
          <span>{label}</span>
          <span style={{ opacity: 0.7, fontSize: 'var(--console-font-micro)' }}>at {relativeTime}</span>
        </div>
      )}
    </button>
  );
}
