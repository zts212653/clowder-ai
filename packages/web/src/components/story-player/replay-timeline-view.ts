import type { ReplayEvent, SpeedMultiplier } from '@/lib/story-player/types';

export const REPLAY_SPEEDS: readonly SpeedMultiplier[] = [1, 10, 50, 100, 'max'];

export function replaySpeedLabel(speed: SpeedMultiplier): string {
  return speed === 'max' ? '最快' : `${speed}×`;
}

export function replayDuration(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  const minutes = Math.floor(seconds / 60);
  return minutes >= 60
    ? `${Math.floor(minutes / 60)}:${String(minutes % 60).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`
    : `${minutes}:${String(seconds % 60).padStart(2, '0')}`;
}

export function idleDurationLabel(ms: number): string {
  return ms < 60000 ? `${Math.round(ms / 1000)} 秒` : `${Math.round(ms / 60000)} 分钟`;
}

export interface ReplayActorSpan {
  from: number;
  to: number;
  role: string;
  catId?: string;
}

/** Index coordinates are the original seek coordinates, never a second clock or idle classifier. */
export function replayTimelineView(events: readonly ReplayEvent[]) {
  const spans: ReplayActorSpan[] = [];
  const idleGaps: Array<{ from: number; to: number; durationMs: number }> = [];
  events.forEach((event, index) => {
    const previous = spans[spans.length - 1];
    if (previous && previous.role === event.role && previous.catId === event.catId) previous.to = index;
    else spans.push({ from: index, to: index, role: event.role, catId: event.catId });
    if (index > 0 && event.idleSkipMs != null) {
      idleGaps.push({ from: index - 1, to: index, durationMs: event.idleSkipMs });
    }
  });
  return { spans, idleGaps };
}
