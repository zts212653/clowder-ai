'use client';

import type { ChapterKind } from '@/lib/story-player/chapters';
import type { SpeedMultiplier } from '@/lib/story-player/types';
import type { UseThreadReplayResult } from '@/lib/story-player/useThreadReplay';
import { AppTooltip } from '../AppTooltip';
import { ReplayTimelineV2 } from './ReplayTimelineV2';
import { idleDurationLabel, REPLAY_SPEEDS, replayDuration, replaySpeedLabel } from './replay-timeline-view';

const chapterTitles: Record<ChapterKind, string> = {
  session_start: '开始',
  session_end: '结束',
  invocation: '新一轮',
  pass_ball: '传球',
  post_idle: '空闲后继续',
};

export function ReplayControlsV2({ replay }: { replay: UseThreadReplayResult }) {
  const { engine, events, activeSkip, chapters, densityBuckets } = replay;
  const hasEvents = engine.totalEvents > 0;
  const playing = engine.state === 'playing';
  return (
    <div className="replay-v2-controls">
      <ReplayTimelineV2 events={events} currentIndex={engine.currentIndex} onSeek={replay.doSeek} />
      <div className="replay-v2-control-row">
        <AppTooltip label={playing ? '暂停回放' : engine.state === 'ended' ? '重新播放' : '播放回放'} side="top">
          <button
            type="button"
            className="replay-v2-play"
            disabled={!hasEvents}
            aria-label={playing ? '暂停回放' : engine.state === 'ended' ? '重新播放' : '播放回放'}
            onClick={replay.togglePlayPause}
          >
            <svg
              viewBox="0 0 24 24"
              width="16"
              height="16"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.5"
              aria-hidden="true"
            >
              {playing ? (
                <>
                  <path d="M8 6v12" />
                  <path d="M16 6v12" />
                </>
              ) : (
                <path d="m8 5 11 7-11 7Z" />
              )}
            </svg>
          </button>
        </AppTooltip>
        <span className="replay-v2-counter">
          <span>
            {replayDuration(engine.elapsedMs)} / {replayDuration(engine.totalDurationMs)}
          </span>
          <span>
            {hasEvents ? Math.min(engine.currentIndex + 1, engine.totalEvents) : 0} / {engine.totalEvents} 个事件
          </span>
        </span>
        <div className="replay-v2-speeds" role="group" aria-label="播放速度">
          {REPLAY_SPEEDS.map((speed) => (
            <button
              type="button"
              key={speed}
              aria-pressed={engine.speed === speed}
              onClick={() => replay.doSetSpeed(speed)}
            >
              {replaySpeedLabel(speed)}
            </button>
          ))}
        </div>
        <select
          className="replay-v2-speed-select"
          aria-label="播放速度"
          value={engine.speed}
          onChange={(event) =>
            replay.doSetSpeed(event.target.value === 'max' ? 'max' : (Number(event.target.value) as SpeedMultiplier))
          }
        >
          {REPLAY_SPEEDS.map((speed) => (
            <option value={speed} key={speed}>
              {replaySpeedLabel(speed)}
            </option>
          ))}
        </select>
        <AppTooltip label="跳过空闲" detail="自动跳过长空闲，并在传球时放慢；播放速度档位保持不变" side="top">
          <button
            type="button"
            className="replay-v2-adaptive"
            aria-pressed={engine.adaptivePacing}
            onClick={replay.doToggleAdaptivePacing}
          >
            跳过空闲
          </button>
        </AppTooltip>
        <details className="replay-v2-more">
          <summary aria-label="更多回放操作">···</summary>
          <div>
            <button type="button" disabled={!hasEvents} onClick={replay.doStepBackward}>
              上一个事件
            </button>
            <button type="button" disabled={!hasEvents} onClick={replay.doStepForward}>
              下一个事件
            </button>
            <p>章节 {chapters.length}</p>
            {chapters.map((chapter) => (
              <button
                type="button"
                key={`${chapter.kind}-${chapter.eventIndex}`}
                onClick={() => replay.doSeek(chapter.eventIndex)}
              >
                {replayDuration(chapter.timestamp - events[0].timestamp)} · {chapterTitles[chapter.kind]}
              </button>
            ))}
            {densityBuckets.length > 0 && (
              <div className="replay-v2-density" role="img" aria-label="事件密度">
                {densityBuckets.map((bucket, index) => (
                  <span key={index} style={{ height: `${Math.max(2, bucket.density * 100)}%` }} />
                ))}
              </div>
            )}
          </div>
        </details>
      </div>
      {activeSkip && (
        <p className="replay-v2-skip" role="status">
          本段空闲 {idleDurationLabel(activeSkip.originalGapMs)}
        </p>
      )}
    </div>
  );
}
