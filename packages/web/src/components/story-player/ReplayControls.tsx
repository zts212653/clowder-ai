/**
 * F252 Story Player — Replay Controls Bar
 *
 * Bottom control bar with: play/pause, speed selector, progress bar (seekable),
 * time display, display mode toggle.
 */

'use client';

import type { Chapter } from '@/lib/story-player/chapters';
import type { DensityBucket } from '@/lib/story-player/event-density';
import type { ReplayEngineState, SpeedMultiplier } from '@/lib/story-player/types';
import { ReplayProgressBar } from './ReplayProgressBar';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface ReplayControlsProps {
  engine: ReplayEngineState;
  /** Active skip indicator — non-null when current event follows a long idle gap */
  activeSkip: { originalGapMs: number } | null;
  /** Chapters for timeline navigation (AC-B2) */
  chapters: Chapter[];
  /** Event density buckets for heatmap overlay (AC-E7) */
  densityBuckets: DensityBucket[];
  onTogglePlayPause: () => void;
  onSeek: (index: number) => void;
  onSetSpeed: (speed: SpeedMultiplier) => void;
  onToggleDisplayMode: () => void;
  onToggleAdaptivePacing: () => void;
}

interface PlayPauseButtonProps {
  state: ReplayEngineState['state'];
  hasEvents: boolean;
  onTogglePlayPause: () => void;
}

// ---------------------------------------------------------------------------
// Speed options
// ---------------------------------------------------------------------------

const SPEED_OPTIONS: SpeedMultiplier[] = [1, 10, 50, 100, 'max'];

function formatSpeed(speed: SpeedMultiplier): string {
  return speed === 'max' ? 'MAX' : `${speed}×`;
}

// ---------------------------------------------------------------------------
// Time formatting
// ---------------------------------------------------------------------------

function formatDuration(ms: number): string {
  const totalSeconds = Math.floor(ms / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;

  if (hours > 0) {
    return `${hours}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
  }
  return `${minutes}:${String(seconds).padStart(2, '0')}`;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

/** Format skip duration for the "⏩ 跳过 N 分钟" indicator */
function formatSkipDuration(ms: number): string {
  const minutes = Math.round(ms / 60_000);
  if (minutes < 1) return `${Math.round(ms / 1000)} 秒`;
  if (minutes < 60) return `${minutes} 分钟`;
  const hours = Math.floor(minutes / 60);
  const remainMin = minutes % 60;
  return remainMin > 0 ? `${hours} 小时 ${remainMin} 分钟` : `${hours} 小时`;
}

function PlayPauseButton({ state, hasEvents, onTogglePlayPause }: PlayPauseButtonProps) {
  const playIcon = state === 'playing' ? '⏸' : state === 'ended' ? '↻' : '▶';

  return (
    <button
      type="button"
      onClick={onTogglePlayPause}
      aria-label={state === 'playing' ? 'Pause' : 'Play'}
      disabled={!hasEvents}
      style={{
        background: 'none',
        border: '1px solid var(--color-border, #555)',
        borderRadius: '4px',
        color: 'inherit',
        cursor: hasEvents ? 'pointer' : 'not-allowed',
        fontSize: 'var(--console-font-base)',
        opacity: hasEvents ? 1 : 0.5,
        padding: '4px 8px',
        minWidth: '36px',
      }}
    >
      {playIcon}
    </button>
  );
}

export function ReplayControls({
  engine,
  activeSkip,
  chapters,
  densityBuckets,
  onTogglePlayPause,
  onSeek,
  onSetSpeed,
  onToggleDisplayMode,
  onToggleAdaptivePacing,
}: ReplayControlsProps) {
  const hasEvents = engine.totalEvents > 0;
  const currentEventLabel = hasEvents ? Math.min(engine.currentIndex + 1, engine.totalEvents) : 0;
  // Derive baseline timestamp from earliest chapter (not session_start specifically,
  // because deduplication may remove it when a higher-priority kind shares eventIndex 0,
  // e.g., pass_ball priority 4 > session_start priority 1).
  const sessionStartTs = chapters[0]?.timestamp ?? 0;

  const progress =
    engine.totalEvents > 1
      ? (engine.currentIndex / (engine.totalEvents - 1)) * 100
      : engine.totalEvents === 1
        ? 100
        : 0;

  return (
    <div
      style={{
        position: 'fixed',
        bottom: 0,
        left: 0,
        right: 0,
        background: 'var(--color-surface-elevated, #1a1a2e)',
        borderTop: '1px solid var(--color-border, #333)',
        padding: '8px 16px',
        display: 'flex',
        alignItems: 'center',
        gap: '12px',
        zIndex: 100,
        color: 'var(--color-text-primary, #e0e0e0)',
        fontFamily: 'var(--font-mono, monospace)',
        fontSize: 'var(--console-font-compact)',
      }}
    >
      {/* Play/Pause button */}
      <PlayPauseButton state={engine.state} hasEvents={hasEvents} onTogglePlayPause={onTogglePlayPause} />

      {/* Progress bar */}
      <ReplayProgressBar
        engine={engine}
        hasEvents={hasEvents}
        progress={progress}
        chapters={chapters}
        densityBuckets={densityBuckets}
        sessionStartTs={sessionStartTs}
        onSeek={onSeek}
      />

      {/* Event counter */}
      <span style={{ minWidth: '80px', textAlign: 'center', fontSize: 'var(--console-font-xs)', opacity: 0.8 }}>
        {currentEventLabel} / {engine.totalEvents}
      </span>

      {/* Time display */}
      <span style={{ minWidth: '100px', textAlign: 'center', fontSize: 'var(--console-font-xs)', opacity: 0.7 }}>
        {formatDuration(engine.elapsedMs)} / {formatDuration(engine.totalDurationMs)}
      </span>

      {/* Speed selector */}
      <div style={{ display: 'flex', gap: '2px' }}>
        {SPEED_OPTIONS.map((s) => (
          <button
            type="button"
            key={String(s)}
            onClick={() => onSetSpeed(s)}
            style={{
              background: engine.speed === s ? 'var(--color-accent, #6366f1)' : 'transparent',
              border: '1px solid var(--color-border, #555)',
              borderRadius: '3px',
              color: engine.speed === s ? '#fff' : 'inherit',
              cursor: 'pointer',
              fontSize: 'var(--console-font-label)',
              padding: '2px 6px',
            }}
          >
            {formatSpeed(s)}
          </button>
        ))}
      </div>

      {/* Adaptive pacing toggle (AC-B1) */}
      <button
        type="button"
        onClick={onToggleAdaptivePacing}
        title={
          engine.adaptivePacing
            ? 'Adaptive pacing ON — auto-skips idle gaps, slows at pass-ball'
            : 'Adaptive pacing OFF — fixed speed only'
        }
        style={{
          background: engine.adaptivePacing ? 'var(--color-accent, #6366f1)' : 'transparent',
          border: '1px solid var(--color-border, #555)',
          borderRadius: '3px',
          color: engine.adaptivePacing ? '#fff' : 'inherit',
          cursor: 'pointer',
          fontSize: 'var(--console-font-label)',
          padding: '2px 8px',
        }}
      >
        🎯 Adaptive
      </button>

      {/* Display mode toggle */}
      <button
        type="button"
        onClick={onToggleDisplayMode}
        title={`Mode: ${engine.displayMode}`}
        style={{
          background: 'none',
          border: '1px solid var(--color-border, #555)',
          borderRadius: '3px',
          color: 'inherit',
          cursor: 'pointer',
          fontSize: 'var(--console-font-label)',
          padding: '2px 8px',
        }}
      >
        {engine.displayMode === 'cinematic' ? '🎬 Cinematic' : '📋 Faithful'}
      </button>

      {/* Skip indicator (AC-B1) — shown when current event follows a long idle gap */}
      {activeSkip && (
        <>
          <style>{`
            @keyframes skipFadeInOut {
              0% { opacity: 0; transform: translate(-50%, -50%) scale(0.95); }
              15% { opacity: 1; transform: translate(-50%, -50%) scale(1); }
              75% { opacity: 1; transform: translate(-50%, -50%) scale(1); }
              100% { opacity: 0; transform: translate(-50%, -50%) scale(0.95); }
            }
          `}</style>
          <div
            style={{
              position: 'fixed',
              top: '50%',
              left: '50%',
              transform: 'translate(-50%, -50%)',
              background: 'var(--console-overlay-backdrop)',
              color: 'var(--queue-on-accent)',
              padding: '12px 24px',
              borderRadius: '8px',
              fontSize: 'var(--console-font-base)',
              fontFamily: 'var(--font-mono, monospace)',
              pointerEvents: 'none',
              zIndex: 200,
              animation: 'skipFadeInOut 2s ease-in-out forwards',
            }}
          >
            ⏩ 跳过 {formatSkipDuration(activeSkip.originalGapMs)}
          </div>
        </>
      )}
    </div>
  );
}
