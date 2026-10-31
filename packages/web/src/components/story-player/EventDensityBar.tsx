/**
 * F252 Phase E PR E-2 — Event Density Heatmap Bar (AC-E7 partial)
 *
 * Semi-transparent overlay on the progress bar showing relative event
 * density. Renders ON TOP of the progress fill (z-index: 2) so density
 * is visible in both played and unplayed regions.
 *
 * Uses white overlay for consistent visibility on both accent fill
 * (played) and dark track (unplayed) backgrounds.
 */

'use client';

import type { DensityBucket } from '@/lib/story-player/event-density';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface EventDensityBarProps {
  /** Density buckets from computeEventDensity */
  buckets: DensityBucket[];
  /** Current progress percentage [0, 100] — reserved for future per-region styling */
  progress?: number;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function EventDensityBar({ buckets }: EventDensityBarProps) {
  if (buckets.length === 0) return null;

  const bucketWidthPct = 100 / buckets.length;

  return (
    <div
      aria-hidden="true"
      style={{
        position: 'absolute',
        inset: 0,
        display: 'flex',
        alignItems: 'flex-end',
        borderRadius: '3px',
        overflow: 'hidden',
        pointerEvents: 'none',
        zIndex: 2,
      }}
    >
      {buckets.map((bucket, i) => {
        // Use white overlay — visible on both accent fill (played) and dark track (future)
        const height = `${Math.max(bucket.density * 100, 0)}%`;
        const opacity = bucket.density > 0 ? 0.15 + bucket.density * 0.2 : 0;

        return (
          <div
            key={`d${i}`}
            style={{
              flex: `0 0 ${bucketWidthPct}%`,
              height,
              background: 'rgba(255, 255, 255, 0.9)',
              opacity,
              transition: 'height 0.15s ease, opacity 0.15s ease',
            }}
          />
        );
      })}
    </div>
  );
}
