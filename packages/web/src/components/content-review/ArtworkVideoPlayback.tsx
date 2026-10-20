'use client';
import { type RefObject, useEffect, useState } from 'react';
import { useShellCopy } from '@/components/shell/shell-copy';
import { ReviewToolbarIcon } from './ReviewToolbarIcon';
import { videoArtworkCopy } from './video-artwork.shell-copy';

const clock = (seconds: number) => `${Math.floor(seconds / 60)}:${String(Math.floor(seconds % 60)).padStart(2, '0')}`;
/** One playback strip drives the original element and its owner's existing seek fence. */
export function ArtworkVideoPlayback({
  video,
  seconds,
  duration,
  paused,
  seekTo,
  fullscreen,
}: {
  video: RefObject<HTMLVideoElement>;
  seconds: number;
  duration: number;
  paused: boolean;
  seekTo: (seconds: number) => void;
  fullscreen?: { active: boolean; failed: boolean; toggle: () => void; available: boolean };
}) {
  const t = useShellCopy(videoArtworkCopy);
  const [volume, setVolume] = useState(1),
    [rate, setRate] = useState(1);
  useEffect(() => {
    const node = video.current;
    if (!node) return;
    const update = () => {
      setVolume(node.muted ? 0 : node.volume);
      setRate(node.playbackRate);
    };
    update();
    node.addEventListener('volumechange', update);
    node.addEventListener('ratechange', update);
    return () => {
      node.removeEventListener('volumechange', update);
      node.removeEventListener('ratechange', update);
    };
  }, [video]);
  return (
    <div className="flex items-center gap-3">
      <button
        type="button"
        aria-label={paused ? t.play : t.pause}
        onClick={() => {
          const node = video.current;
          if (!node) return;
          if (node.paused) void node.play().catch(() => {});
          else node.pause();
        }}
      >
        {paused ? '▶' : 'Ⅱ'}
      </button>
      <span className="shrink-0 tabular-nums">
        {clock(seconds)} / {clock(duration)}
      </span>
      <input
        type="range"
        aria-label={t.position}
        className="min-w-0 flex-1 accent-cafe-accent"
        min="0"
        max={duration}
        step="any"
        value={seconds}
        onChange={(event) => seekTo(Number(event.target.value))}
      />
      <label className="flex shrink-0 items-center gap-1">
        <ReviewToolbarIcon name="volume" />
        <input
          type="range"
          aria-label={t.volume}
          className="w-14 accent-cafe-accent"
          min="0"
          max="1"
          step="0.05"
          value={volume}
          onChange={(event) => {
            const node = video.current;
            if (node) {
              const value = Number(event.target.value);
              node.muted = false;
              node.volume = value;
              // Native media events arrive later; keep consecutive user input current.
              setVolume(value);
            }
          }}
        />
      </label>
      <select
        aria-label={t.speed}
        value={rate}
        className="bg-transparent"
        onChange={(event) => {
          if (video.current) {
            const value = Number(event.target.value);
            video.current.playbackRate = value;
            setRate(value);
          }
        }}
      >
        {[0.5, 1, 1.25, 1.5, 2].map((speed) => (
          <option key={speed} value={speed}>
            {speed}×
          </option>
        ))}
      </select>
      {fullscreen?.available ? (
        <button
          type="button"
          aria-label={fullscreen.active ? t.exitFullscreen : t.fullscreen}
          title={`${fullscreen.active ? t.exitFullscreen : t.fullscreen} · F`}
          onClick={fullscreen.toggle}
        >
          <ReviewToolbarIcon name={fullscreen.active ? 'exitFullscreen' : 'fullscreen'} />
        </button>
      ) : null}
      {fullscreen?.failed ? <span role="status">{t.fullscreenFailed}</span> : null}
    </div>
  );
}
