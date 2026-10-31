'use client';
import { mediaPtsToProjectTick, projectTickToMediaPts, type VideoProjectScreening } from '@cat-cafe/shared';
import { useEffect, useRef, useState } from 'react';
import { useChatStore } from '@/stores/chatStore';
import { API_URL } from '@/utils/api-client';
import { browserTimeToTick, tickToBrowserTime } from '../../content-review/review-geometry';
import { usePresentedVideoFrame } from '../../content-review/usePresentedVideoFrame';
import { useWorkspaceSurfaceVisibility } from '../WorkspaceSurfaceVisibility';
import type { ProjectSnapshot } from './api';
import { ScreeningRegion } from './ScreeningRegion';
import { ScreeningPlaybackControls } from './screening-ui/ScreeningPlaybackControls';
import { ScreeningTimelineNavigation } from './screening-ui/ScreeningTimelineNavigation';
import { useScreeningCopy } from './screening-ui/screening.shell-copy';
import { queuePresentedScreeningSelection } from './screening-ui/screening-player-selection';
import { screeningTime } from './screening-ui/screening-time';
import type { screeningSelection } from './selection';

export function VideoProjectScreeningPlayer({
  screening,
  input,
  mediaUrl,
  focus,
  markRequest,
  opinionPositions = [],
}: {
  screening: VideoProjectScreening;
  input: ProjectSnapshot;
  mediaUrl: string;
  focus?: { pts: number; requestId: number } | null;
  markRequest?: number;
  opinionPositions?: { id: string; pts: number }[];
}) {
  const t = useScreeningCopy();
  const video = useRef<HTMLVideoElement>(null);
  const src = `${API_URL}${mediaUrl}`,
    media = screening.media.media;
  const frame = usePresentedVideoFrame(video, src);
  const threadId = useChatStore((state) => state.currentThreadId);
  const visible = useWorkspaceSurfaceVisibility();
  const loopSegment = useRef<{ startTick: number; durationTicks: number } | null>(null);
  const [marking, setMarking] = useState(false),
    [loop, setLoop] = useState(false);
  const [status, setStatus] = useState<string | null>(null),
    [error, setError] = useState<string | null>(null);
  const [mode, setMode] = useState<'moment' | 'segment' | 'project'>('moment');
  const [start, setStart] = useState<number | null>(null);
  const [region, setRegion] = useState<Parameters<typeof screeningSelection>[0]['displayRegion']>();
  const pts = frame.frameTime === null ? null : browserTimeToTick(frame.frameTime, media);
  const tick = pts === null ? null : mediaPtsToProjectTick(screening, pts);
  const current =
    tick === null
      ? undefined
      : input.document.timeline.segments.find(
          (item) => item.startTick <= tick && item.startTick + item.durationTicks > tick,
        );
  const frameSeconds = media.frameRate ? media.frameRate.denominator / media.frameRate.numerator : null;
  const beginMark = () => {
    video.current?.pause();
    setMarking(true);
    setStatus(null);
  };
  useEffect(() => {
    if (markRequest && markRequest > 0) {
      video.current?.pause();
      setMarking(true);
      setStatus(null);
    }
  }, [markRequest]);
  useEffect(() => {
    if (!visible) {
      video.current?.pause();
      return;
    }
    // Embedded pictures receive the shared surface action; standalone players own their shortcut.
    if (markRequest !== undefined) return;
    const key = (event: KeyboardEvent) => {
      const target = event.target instanceof HTMLElement ? event.target : null;
      if (
        event.key.toLowerCase() !== 'm' ||
        event.defaultPrevented ||
        event.repeat ||
        event.isComposing ||
        event.ctrlKey ||
        event.metaKey ||
        event.altKey ||
        target?.closest(
          'input,textarea,select,[contenteditable]:not([contenteditable=false]),[role=textbox],[role=combobox]',
        )
      )
        return;
      event.preventDefault();
      video.current?.pause();
      setMarking(true);
    };
    window.addEventListener('keydown', key);
    return () => window.removeEventListener('keydown', key);
  }, [visible, markRequest]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: a selection belongs to its decoded frame, and expires when PTS changes.
  useEffect(() => {
    setRegion(undefined);
  }, [pts]);
  const focusSeconds = focus ? tickToBrowserTime(focus.pts, media) : null,
    focusRequestId = focus?.requestId;
  useEffect(() => {
    if (focusSeconds !== null && focusRequestId !== undefined) frame.seekTo(focusSeconds);
  }, [focusSeconds, focusRequestId, frame.seekTo]);
  const mark = () => {
    if (pts === null) return;
    try {
      const result = queuePresentedScreeningSelection({
        threadId,
        screening,
        project: input,
        pts,
        rangeStart: start,
        frameSeconds,
        mode,
        region,
      });
      setStatus(result.kind === 'queued' ? t.queued : result.reason);
      if (result.kind === 'queued') {
        setMarking(false);
        setStart(null);
        setRegion(undefined);
      }
    } catch (failure) {
      setStatus(failure instanceof Error ? failure.message : '位置暂时无法记下。');
    }
  };
  const seekTick = (target: number) => {
    const mapped = projectTickToMediaPts(screening, target);
    if (mapped === null) {
      setStatus('这段输入尚未对应到当前成片。');
      return;
    }
    frame.seekTo(tickToBrowserTime(mapped, media));
    setStatus(null);
  };
  const timeUpdate = () => {
    const segment = loopSegment.current;
    if (!loop || !segment || !video.current) return;
    const nextTick = mediaPtsToProjectTick(screening, browserTimeToTick(video.current.currentTime, media));
    if (nextTick === null || nextTick >= segment.startTick + segment.durationTicks || nextTick < segment.startTick) {
      const mapped = projectTickToMediaPts(screening, segment.startTick);
      if (mapped !== null) frame.seekTo(tickToBrowserTime(mapped, media), { pause: false });
    }
  };
  return (
    <section className="min-w-0" aria-label={t.film}>
      {markRequest === undefined && (
        <div className="mb-2 flex justify-end">
          <button
            type="button"
            onClick={beginMark}
            className="rounded-lg bg-cafe-accent px-4 py-2 text-sm font-semibold text-white"
          >
            ⚑ {t.mark} <kbd className="ml-2 text-xs">M</kbd>
          </button>
        </div>
      )}
      <div className="relative overflow-hidden rounded-xl bg-black">
        {/* biome-ignore lint/a11y/useMediaCaption: Registered source movies have no caption track; do not invent source captions. */}
        <video
          ref={video}
          src={src}
          crossOrigin="use-credentials"
          controls
          preload="metadata"
          playsInline
          aria-label={screening.title}
          className="block max-h-[48vh] w-full object-contain"
          onSeeking={frame.onSeeking}
          onSeeked={frame.onSeeked}
          onTimeUpdate={timeUpdate}
          onError={() => setError('成片暂时无法播放。请重新打开或检查这版成片是否可读。')}
        />
        {marking && mode === 'moment' && (
          <ScreeningRegion
            key={pts ?? 'seeking'}
            video={video}
            media={media}
            ready={pts !== null}
            region={region}
            onRegion={setRegion}
          />
        )}
      </div>
      {error && (
        <p role="alert" className="mt-2 text-sm text-cafe-secondary">
          {error}
        </p>
      )}
      {marking && (
        <div className="mt-3 rounded-xl border border-cafe-subtle bg-cafe-surface p-3 text-sm">
          <div className="flex flex-wrap gap-3">
            {(['moment', 'segment', 'project'] as const).map((value, index) => (
              <button
                type="button"
                key={value}
                aria-pressed={mode === value}
                className={`rounded px-2 py-1 ${mode === value ? 'bg-cafe-surface-sunken font-semibold ring-1 ring-cafe-accent' : 'text-cafe-secondary'}`}
                onClick={() => {
                  setMode(value);
                  setRegion(undefined);
                }}
              >
                {[t.moment, t.shot, t.whole][index]}
              </button>
            ))}
          </div>
          <div className="mt-3 flex flex-wrap gap-3">
            <button type="button" disabled={pts === null} onClick={() => setStart(pts)}>
              {t.rangeStart}
            </button>
            {start !== null && <span>{t.start(screeningTime(tickToBrowserTime(start, media), true))}</span>}
            <button
              type="button"
              onClick={() => {
                setStart(null);
                setRegion(undefined);
              }}
            >
              {t.clear}
            </button>
            <button
              type="button"
              disabled={pts === null}
              onClick={mark}
              className="ml-auto rounded-lg bg-cafe-accent px-3 py-1.5 text-white"
            >
              {t.queue}
            </button>
            <button
              type="button"
              onClick={() => {
                setMarking(false);
                setStart(null);
                setRegion(undefined);
                setMode('moment');
                setStatus(null);
              }}
            >
              {t.cancel}
            </button>
          </div>
          <p className="mt-2 text-xs text-cafe-muted">{t.markingHint}</p>
        </div>
      )}
      {status && <output className="mt-3 text-xs text-cafe-secondary">{status}</output>}
      <ScreeningPlaybackControls
        media={media}
        pts={pts}
        current={current}
        loop={loop}
        opinionPositions={opinionPositions}
        onSeek={frame.seekTo}
        onLoop={() => {
          loopSegment.current = current ?? null;
          setLoop((value) => !value);
        }}
      />
      <ScreeningTimelineNavigation
        timeline={input.document.timeline}
        current={current}
        onSeek={seekTick}
        assets={input.document.assets}
        contentRef={input.contentRef}
        ownerRevision={input.ownerRevision}
      />
    </section>
  );
}
