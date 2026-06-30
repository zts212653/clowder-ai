/**
 * F252 Story Player — Replay progress slider with chapters and density.
 */

'use client';

import { type Chapter, selectVisibleChapters } from '@/lib/story-player/chapters';
import type { DensityBucket } from '@/lib/story-player/event-density';
import type { ReplayEngineState } from '@/lib/story-player/types';
import { ChapterBadge } from './ChapterBadge';
import { EventDensityBar } from './EventDensityBar';

interface ReplayProgressBarProps {
  engine: ReplayEngineState;
  hasEvents: boolean;
  progress: number;
  chapters: Chapter[];
  densityBuckets: DensityBucket[];
  sessionStartTs: number;
  onSeek: (index: number) => void;
}

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

function chapterIcon(kind: Chapter['kind']): string {
  switch (kind) {
    case 'session_start':
      return '▶';
    case 'session_end':
      return '⏹';
    case 'invocation':
      return '🔄';
    case 'pass_ball':
      return '🏐';
    case 'post_idle':
      return '⏩';
    default:
      return '📍';
  }
}

export function ReplayProgressBar({
  engine,
  hasEvents,
  progress,
  chapters,
  densityBuckets,
  sessionStartTs,
  onSeek,
}: ReplayProgressBarProps) {
  const currentSliderValue = hasEvents ? Math.min(engine.currentIndex, engine.totalEvents - 1) : 0;
  const visibleChapters = selectVisibleChapters(
    chapters.filter((ch) => ch.kind !== 'session_start' && ch.kind !== 'session_end'),
    engine.totalEvents,
  );

  return (
    <div
      role="slider"
      tabIndex={hasEvents ? 0 : -1}
      aria-label="Replay progress"
      aria-valuemin={0}
      aria-valuemax={Math.max(engine.totalEvents - 1, 0)}
      aria-valuenow={currentSliderValue}
      style={{ flex: 1, position: 'relative', height: '6px', cursor: hasEvents ? 'pointer' : 'not-allowed' }}
      onClick={(e) => {
        if (!hasEvents) return;
        const rect = e.currentTarget.getBoundingClientRect();
        const pct = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
        const targetIndex = Math.round(pct * Math.max(engine.totalEvents - 1, 0));
        onSeek(targetIndex);
      }}
      onKeyDown={(e) => {
        if (!hasEvents) return;
        if (e.key === 'ArrowRight') onSeek(Math.min(engine.currentIndex + 1, engine.totalEvents - 1));
        else if (e.key === 'ArrowLeft') onSeek(Math.max(engine.currentIndex - 1, 0));
      }}
    >
      <div
        style={{
          position: 'absolute',
          inset: 0,
          background: 'var(--color-surface-secondary, #2a2a3e)',
          borderRadius: '3px',
        }}
      />
      <EventDensityBar buckets={densityBuckets} progress={progress} />
      {visibleChapters.map((ch) => {
        const pct = engine.totalEvents > 1 ? (ch.eventIndex / (engine.totalEvents - 1)) * 100 : 0;
        return (
          <ChapterBadge
            key={`ch-${ch.eventIndex}`}
            kind={ch.kind}
            label={`${chapterIcon(ch.kind)} ${ch.label}`}
            icon={chapterIcon(ch.kind)}
            position={pct}
            isPast={ch.eventIndex <= engine.currentIndex}
            relativeTime={formatDuration(ch.timestamp - sessionStartTs)}
            onClick={() => onSeek(ch.eventIndex)}
          />
        );
      })}
      <div
        style={{
          position: 'absolute',
          top: 0,
          bottom: 0,
          left: 0,
          width: `${progress}%`,
          background: 'var(--color-accent, #6366f1)',
          borderRadius: '3px',
          transition: 'width 0.1s linear',
          zIndex: 1,
        }}
      />
    </div>
  );
}
