'use client';

import { useMemo } from 'react';
import { catColorVar } from '@/lib/cat-slug';
import type { ReplayEvent } from '@/lib/story-player/types';
import { replayTimelineView } from './replay-timeline-view';

export function ReplayTimelineV2({
  events,
  currentIndex,
  onSeek,
}: {
  events: readonly ReplayEvent[];
  currentIndex: number;
  onSeek: (index: number) => void;
}) {
  const timeline = useMemo(() => replayTimelineView(events), [events]);
  const max = Math.max(0, events.length - 1);
  const position = (index: number) => (max > 0 ? (index / max) * 100 : 0);
  const actorColor = (role: string, catId?: string) =>
    role === 'user'
      ? catColorVar('cocreator')
      : role === 'assistant' && catId
        ? catColorVar(catId)
        : 'var(--cafe-text-muted)';
  return (
    <div className="replay-v2-timeline">
      <svg viewBox="0 0 100 16" preserveAspectRatio="none" aria-hidden="true">
        <line x1="0" x2="100" y1="8" y2="8" stroke="var(--cafe-border)" strokeWidth="2" />
        {timeline.spans.map((span) => (
          <line
            key={span.from}
            x1={position(span.from)}
            x2={position(span.to)}
            y1="8"
            y2="8"
            stroke={actorColor(span.role, span.catId)}
            strokeWidth="3"
            data-actor={span.catId ?? span.role}
          />
        ))}
        <line x1="0" x2={position(currentIndex)} y1="8" y2="8" stroke="var(--cafe-text)" strokeWidth="2" />
        {timeline.spans.map((span) => (
          <line
            key={`tick-${span.from}`}
            x1={position(span.from)}
            x2={position(span.from)}
            y1="3"
            y2="13"
            stroke={actorColor(span.role, span.catId)}
            strokeWidth="0.4"
          />
        ))}
        {timeline.idleGaps.map((gap) => (
          <line
            key={`idle-${gap.to}`}
            x1={position(gap.from)}
            x2={position(gap.to)}
            y1="8"
            y2="8"
            stroke="var(--cafe-text-muted)"
            strokeWidth="2"
            strokeDasharray="0.6 0.6"
            data-idle-ms={gap.durationMs}
          />
        ))}
      </svg>
      <input
        type="range"
        min={0}
        max={max}
        step={1}
        value={Math.min(currentIndex, max)}
        disabled={events.length === 0}
        aria-label="回放进度"
        aria-valuetext={`${events.length ? Math.min(currentIndex + 1, events.length) : 0} / ${events.length} 个事件`}
        onInput={(event) => onSeek(Number(event.currentTarget.value))}
      />
    </div>
  );
}
