'use client';
import { useCallback, useEffect, useMemo, useRef } from 'react';
import { useComparePlayback } from '@/components/content-review/media-compare/useComparePlayback';
import { tickToBrowserTime } from '@/components/content-review/review-geometry';
import { usePresentedVideoFrame } from '@/components/content-review/usePresentedVideoFrame';
import {
  comparePairKey,
  comparePairMatchesInput,
  compareScreeningPosition,
  type ScreeningCompareSide,
} from './compare-alignment';
import { useScreeningCopy } from './screening-ui/screening.shell-copy';
import { screeningTime } from './screening-ui/screening-time';
import styles from './VideoProjectReviewSurface.module.css';

export type VideoProjectScreeningCompareProps = {
  left: ScreeningCompareSide;
  right: ScreeningCompareSide;
  onRightFrame?: (mediaTime: number | null) => void;
};
export function VideoProjectScreeningCompare(props: VideoProjectScreeningCompareProps) {
  return <CompareSession key={comparePairKey(props.left, props.right)} {...props} />;
}
function CompareSession({ left, right, onRightFrame }: VideoProjectScreeningCompareProps) {
  const t = useScreeningCopy();
  const rightVideo = useRef<HTMLVideoElement | null>(null);
  const frameCallback = useRef(onRightFrame);
  frameCallback.current = onRightFrame;
  const start = tickToBrowserTime(right.screening.media.media.startTick, right.screening.media.media);
  const valid = comparePairMatchesInput(left, right);
  const alignment = useMemo(
    () => ({
      driver: 1 as const,
      position: (elapsed: number, index: number) => {
        if (index === 1) return { seconds: start + elapsed, rateScale: 1 };
        const result = compareScreeningPosition(right, left, start + elapsed);
        return result.kind === 'aligned' ? { seconds: result.leftMediaTime, rateScale: result.rateScale } : null;
      },
    }),
    [left, right, start],
  );
  const playback = useComparePlayback([left.screening.media.media, right.screening.media.media], alignment);
  const presented = usePresentedVideoFrame(rightVideo, valid ? right.mediaUrl : null);
  const rightRef = useCallback(
    (element: HTMLVideoElement | null) => {
      rightVideo.current = element;
      playback.refs[1](element);
    },
    [playback.refs],
  );
  useEffect(() => {
    frameCallback.current?.(valid ? presented.frameTime : null);
  }, [valid, presented.frameTime]);
  useEffect(() => () => frameCallback.current?.(null), []);
  const current = compareScreeningPosition(right, left, start + playback.seconds);
  const seek = (seconds: number) => {
    onRightFrame?.(null);
    playback.seek(seconds);
    presented.onSeeking();
  };
  const togglePlay = () => {
    const restarting = !playback.playing && playback.seconds >= playback.duration;
    if (restarting) frameCallback.current?.(null);
    void playback.play();
    if (restarting) presented.onSeeking();
  };
  const missing = current.kind === 'missing';
  const missingMessage = current.kind === 'missing' && current.reason === 'unmapped' ? t.mappingMissing : t.shotMissing;
  const panes = [
    {
      side: left,
      label: t.old,
      ariaLabel: t.old,
      videoLabel: t.oldFilm,
      reference: playback.refs[0],
      muted: true,
      missing,
      onSeeking: undefined,
      onSeeked: undefined,
    },
    {
      side: right,
      label: t.newer,
      ariaLabel: t.newerOpinion,
      videoLabel: t.newFilm,
      reference: rightRef,
      muted: false,
      missing: false,
      onSeeking: () => {
        frameCallback.current?.(null);
        presented.onSeeking();
      },
      onSeeked: () => {
        presented.onSeeked();
        playback.timeUpdate(1);
      },
    },
  ];
  if (!valid)
    return (
      <p role="alert" className="text-sm text-cafe-error">
        成片与剪辑输入版本不一致，请重新打开这两版。
      </p>
    );
  return (
    <section aria-label={t.comparing} className="flex min-h-0 flex-1 flex-col gap-3 p-3 text-cafe">
      <p className="text-xs text-cafe-muted">{t.compareAlignment}</p>
      <div className="grid min-h-0 flex-1 gap-3 md:grid-cols-2">
        {panes.map((pane, index) => (
          <figure
            key={pane.label}
            className="flex min-w-0 flex-col gap-2 rounded-lg border border-cafe-subtle bg-cafe-surface p-2"
            aria-label={pane.ariaLabel}
          >
            <figcaption className="text-sm">
              {pane.label} · {pane.side.screening.title} · {t.input(pane.side.input.ownerRevision)}
            </figcaption>
            <video
              ref={pane.reference}
              src={pane.side.mediaUrl}
              crossOrigin="use-credentials"
              muted={pane.muted}
              playsInline
              preload="metadata"
              hidden={pane.missing}
              className="min-h-0 w-full flex-1 object-contain"
              aria-label={pane.videoLabel}
              onLoadedMetadata={() => playback.loaded(index)}
              onTimeUpdate={() => playback.timeUpdate(index)}
              onSeeking={pane.onSeeking}
              onSeeked={pane.onSeeked}
              onEnded={() => playback.ended(index)}
              onError={() => playback.failed()}
            />
            {pane.missing ? <output className="block text-xs text-cafe-muted">{missingMessage}</output> : null}
          </figure>
        ))}
      </div>
      <div className="flex flex-wrap items-center gap-3 text-sm">
        <button
          type="button"
          disabled={!playback.ready}
          onClick={togglePlay}
          className="rounded-lg border border-cafe-subtle px-3 py-1.5 disabled:opacity-40"
        >
          {playback.playing ? t.pausePair : t.syncPlay}
        </button>
        <input
          type="range"
          aria-label={t.comparePosition}
          min={0}
          max={playback.duration}
          step="0.01"
          value={playback.seconds}
          disabled={!playback.ready}
          onChange={(event) => seek(Number(event.target.value))}
          className={`${styles.slider} min-w-28 flex-1`}
          style={
            {
              '--progress': `${playback.duration > 0 ? (playback.seconds / playback.duration) * 100 : 0}%`,
            } as import('react').CSSProperties
          }
        />
        <output>
          {screeningTime(playback.seconds)} / {screeningTime(playback.duration)}
        </output>
        <label>
          {t.speed}{' '}
          <select
            aria-label={t.compareSpeed}
            value={playback.rate}
            onChange={(event) => playback.setRate(Number(event.target.value))}
            className="rounded border border-cafe-subtle bg-cafe-surface px-2 py-1"
          >
            {[0.5, 1, 1.5, 2].map((rate) => (
              <option key={rate} value={rate}>
                {rate}×
              </option>
            ))}
          </select>
        </label>
      </div>
      {playback.error ? (
        <p role="alert" className="text-xs text-cafe-error">
          {playback.error}
        </p>
      ) : null}
    </section>
  );
}
