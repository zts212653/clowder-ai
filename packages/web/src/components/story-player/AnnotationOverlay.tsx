/**
 * F252 Phase D — Annotation Overlay (AC-D1).
 *
 * Displays annotation cards during replay when playback time
 * matches annotation timestamps (within tolerance window).
 * Auto-pause is handled by the parent page component — this
 * component is a pure display layer.
 */

'use client';

import type { StoryAnnotation } from '@cat-cafe/shared';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface AnnotationOverlayProps {
  annotations: StoryAnnotation[];
  /** Current playback time in ms since epoch */
  currentTime: number;
  /** Tolerance window for matching annotations to current time (ms) */
  toleranceMs?: number;
  onDismiss: () => void;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function formatAnnotationTime(ms: number): string {
  return new Date(ms).toLocaleTimeString('en-US', {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  });
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function AnnotationOverlay({ annotations, currentTime, toleranceMs = 500, onDismiss }: AnnotationOverlayProps) {
  // Find annotations within tolerance of current playback time
  const activeAnnotations = annotations.filter((a) => Math.abs(a.at - currentTime) <= toleranceMs);

  if (activeAnnotations.length === 0) return null;

  return (
    <div style={styles.container}>
      {activeAnnotations.map((annotation) => (
        <div
          key={annotation.id}
          style={{
            ...styles.card,
            borderLeftColor: annotation.kind === 'narration' ? 'var(--color-accent, #6366f1)' : '#f59e0b',
          }}
        >
          <div style={styles.cardHeader}>
            <span style={styles.kindBadge}>
              {annotation.kind === 'narration' ? '💬' : '✨'} {annotation.kind}
            </span>
            <span style={styles.timestamp}>{formatAnnotationTime(annotation.at)}</span>
          </div>
          <div style={styles.content}>{annotation.content}</div>
          <button type="button" onClick={onDismiss} style={styles.dismissButton}>
            Continue ▶
          </button>
        </div>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Timeline annotation markers (for ReplayControls integration)
// ---------------------------------------------------------------------------

interface AnnotationMarkersProps {
  annotations: StoryAnnotation[];
  timeRange: { start: number; end: number };
  onSeekToAnnotation: (annotation: StoryAnnotation) => void;
}

export function AnnotationMarkers({ annotations, timeRange, onSeekToAnnotation }: AnnotationMarkersProps) {
  const rangeDuration = timeRange.end - timeRange.start;
  if (rangeDuration <= 0 || annotations.length === 0) return null;

  return (
    <>
      {annotations.map((a) => {
        const pct = ((a.at - timeRange.start) / rangeDuration) * 100;
        if (pct < 0 || pct > 100) return null;
        return (
          <button
            type="button"
            key={a.id}
            title={`${a.kind === 'narration' ? '💬' : '✨'} ${a.content.slice(0, 40)}`}
            onClick={(e) => {
              e.stopPropagation();
              onSeekToAnnotation(a);
            }}
            style={{
              position: 'absolute',
              left: `${pct}%`,
              top: '-8px',
              width: '6px',
              height: '6px',
              borderRadius: '50%',
              transform: 'translateX(-50%)',
              background: a.kind === 'narration' ? 'var(--color-accent, #6366f1)' : '#f59e0b',
              border: 'none',
              cursor: 'pointer',
              zIndex: 3,
              padding: 0,
            }}
          />
        );
      })}
    </>
  );
}

// ---------------------------------------------------------------------------
// Styles
// ---------------------------------------------------------------------------

const styles: Record<string, React.CSSProperties> = {
  container: {
    position: 'fixed',
    top: '50%',
    left: '50%',
    transform: 'translate(-50%, -50%)',
    zIndex: 250,
    display: 'flex',
    flexDirection: 'column',
    gap: '12px',
    maxWidth: '500px',
    width: '90vw',
  },
  card: {
    background: 'var(--color-surface-elevated, #1a1a2e)',
    border: '1px solid var(--color-border, #333)',
    borderLeft: '4px solid',
    borderRadius: '8px',
    padding: '16px',
    color: 'var(--color-text-primary, #e0e0e0)',
    boxShadow: '0 8px 32px rgba(0, 0, 0, 0.4)',
  },
  cardHeader: {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: '8px',
  },
  kindBadge: {
    fontSize: 'var(--console-font-xs)',
    opacity: 0.8,
    textTransform: 'capitalize',
  },
  timestamp: {
    fontFamily: 'var(--font-mono, monospace)',
    fontSize: 'var(--console-font-label)',
    opacity: 0.5,
  },
  content: {
    fontSize: 'var(--console-font-compact)',
    lineHeight: 1.5,
    whiteSpace: 'pre-wrap',
  },
  dismissButton: {
    marginTop: '12px',
    padding: '4px 12px',
    background: 'var(--color-accent, #6366f1)',
    border: 'none',
    borderRadius: '4px',
    color: '#fff',
    cursor: 'pointer',
    fontSize: 'var(--console-font-xs)',
    float: 'right',
  },
};
