import type { ArtifactReviewAnchor, ImmutableMedia } from '@cat-cafe/shared';
import type { RefObject } from 'react';
import { browserTimeToTick, tickToBrowserTime } from './review-geometry';
import { reviewMediaControl } from './review-media-styles';

export function ReviewMediaControls({
  media,
  round,
  selected,
  canAnnotate,
  src,
  error,
  selectionActive,
  selecting,
  showSelectionControls,
  frameTime,
  seconds,
  videoRef,
  onSelect,
  onSelectingChange,
}: {
  media: ImmutableMedia;
  round: number;
  selected: ArtifactReviewAnchor | null;
  canAnnotate: boolean;
  src: string | null;
  error: string | null;
  selectionActive: boolean;
  selecting: boolean;
  showSelectionControls: boolean;
  frameTime: number | null;
  seconds: number;
  videoRef: RefObject<HTMLVideoElement | null>;
  onSelect: (anchor: ArtifactReviewAnchor) => void;
  onSelectingChange: (next: boolean) => void;
}) {
  return (
    <>
      <div className="flex flex-wrap items-center gap-2">
        {showSelectionControls ? (
          <ReviewMediaActionButtons
            media={media}
            canAnnotate={canAnnotate}
            src={src}
            error={error}
            selectionActive={selectionActive}
            selecting={selecting}
            frameTime={frameTime}
            videoRef={videoRef}
            onSelect={onSelect}
            onSelectingChange={onSelectingChange}
          />
        ) : null}
        {selectionActive ? <p className="text-xs text-cafe-accent">在画面上拖出一个框，再写下你的意见。</p> : null}
        {src ? (
          <a
            className="text-xs text-cafe-muted underline"
            href={src}
            download={`review-version-${round}.${media.kind === 'image' ? 'png' : 'mp4'}`}
          >
            下载原文件
          </a>
        ) : null}
      </div>
      {media.kind === 'video' ? (
        <ReviewVideoRangeControls
          media={media}
          selected={selected?.kind === 'video-range' ? selected : null}
          canAnnotate={canAnnotate}
          seconds={seconds}
          onSelect={onSelect}
        />
      ) : null}
    </>
  );
}

function ReviewMediaActionButtons({
  media,
  canAnnotate,
  src,
  error,
  selectionActive,
  selecting,
  frameTime,
  videoRef,
  onSelect,
  onSelectingChange,
}: {
  media: ImmutableMedia;
  canAnnotate: boolean;
  src: string | null;
  error: string | null;
  selectionActive: boolean;
  selecting: boolean;
  frameTime: number | null;
  videoRef: RefObject<HTMLVideoElement | null>;
  onSelect: (anchor: ArtifactReviewAnchor) => void;
  onSelectingChange: (next: boolean) => void;
}) {
  return (
    <>
      <button
        type="button"
        className={reviewMediaControl}
        disabled={!canAnnotate || !src || !!error || (media.kind === 'video' && frameTime === null)}
        aria-pressed={selectionActive}
        onClick={() => {
          videoRef.current?.pause();
          onSelectingChange(!selecting);
        }}
      >
        {selectionActive ? '取消圈选' : media.kind === 'video' ? '圈出这帧画面' : '圈选区域'}
      </button>
      <button
        type="button"
        className={reviewMediaControl}
        disabled={!canAnnotate || !src}
        onClick={() => {
          if (media.kind === 'image')
            onSelect({ kind: 'image-region', x: 0, y: 0, width: media.width, height: media.height });
          else
            onSelect({
              kind: 'video-range',
              streamId: media.streamId,
              startTick: media.startTick,
              endTick: media.startTick + media.durationTicks,
            });
        }}
      >
        {media.kind === 'image' ? '标注整张图片' : '标注整个片段'}
      </button>
    </>
  );
}

function ReviewVideoRangeControls({
  media,
  selected,
  canAnnotate,
  seconds,
  onSelect,
}: {
  media: Extract<ImmutableMedia, { kind: 'video' }>;
  selected: Extract<ArtifactReviewAnchor, { kind: 'video-range' }> | null;
  canAnnotate: boolean;
  seconds: number;
  onSelect: (anchor: ArtifactReviewAnchor) => void;
}) {
  const rangeStart = tickToBrowserTime(selected?.startTick ?? media.startTick, media);
  const rangeEnd = tickToBrowserTime(selected?.endTick ?? media.startTick + media.durationTicks, media);
  const selectRange = (startSeconds: number, endSeconds: number) => {
    if (!Number.isFinite(startSeconds) || !Number.isFinite(endSeconds)) return;
    const startTick = Math.max(media.startTick, browserTimeToTick(startSeconds, media));
    const endTick = Math.min(media.startTick + media.durationTicks, browserTimeToTick(endSeconds, media));
    if (endTick <= startTick) return;
    const frame = selected?.frameRegion;
    const point = selected?.framePoint;
    onSelect({
      kind: 'video-range',
      streamId: media.streamId,
      startTick,
      endTick,
      ...(frame && frame.tick >= startTick && frame.tick < endTick ? { frameRegion: frame } : {}),
      ...(point && point.tick >= startTick && point.tick < endTick ? { framePoint: point } : {}),
    });
  };
  return (
    <fieldset disabled={!canAnnotate} className="flex flex-wrap items-end gap-2 rounded-xl bg-cafe-surface-sunken p-3">
      <legend className="px-1 text-xs text-cafe-secondary">标注时间范围（秒）</legend>
      <label className="grid gap-1 text-micro text-cafe-muted">
        从
        <input
          aria-label="片段起点"
          type="number"
          step="0.01"
          value={Number(rangeStart.toFixed(3))}
          onChange={(event) => selectRange(Number(event.target.value), rangeEnd)}
          className="w-24 rounded-md border border-cafe-subtle bg-cafe-surface p-2 text-sm text-cafe-black"
        />
      </label>
      <label className="grid gap-1 text-micro text-cafe-muted">
        到
        <input
          aria-label="片段终点"
          type="number"
          step="0.01"
          value={Number(rangeEnd.toFixed(3))}
          onChange={(event) => selectRange(rangeStart, Number(event.target.value))}
          className="w-24 rounded-md border border-cafe-subtle bg-cafe-surface p-2 text-sm text-cafe-black"
        />
      </label>
      <button type="button" className={reviewMediaControl} onClick={() => selectRange(seconds, rangeEnd)}>
        此处为起点
      </button>
      <button type="button" className={reviewMediaControl} onClick={() => selectRange(rangeStart, seconds)}>
        此处为终点
      </button>
    </fieldset>
  );
}
