import { gifAtlasLayout, type ImmutableMedia } from '@cat-cafe/shared';
import styles from './gif-frame-media.module.css';
import { useGifPlayback } from './useGifPlayback';

export function GifFrameMedia({
  src,
  media,
  index,
  onLoad,
  onError,
}: {
  src: string;
  media: Extract<ImmutableMedia, { kind: 'image' }>;
  index: number;
  onLoad: () => void;
  onError: () => void;
}) {
  const count = media.animation?.frameCount ?? 1;
  const { columns, rows } = gifAtlasLayout(media.width, media.height, count);
  return (
    <div
      className={styles.frame}
      role="img"
      aria-label={`GIF 第 ${index + 1} 帧`}
      data-testid="gif-frame-media"
      data-frame-index={index}
    >
      <img
        src={src}
        alt=""
        draggable={false}
        onLoad={onLoad}
        onError={onError}
        data-testid="workspace-content-review-media"
        style={{
          width: `${columns * 100}%`,
          height: `${rows * 100}%`,
          left: `${-(index % columns) * 100}%`,
          top: `${-Math.floor(index / columns) * 100}%`,
        }}
      />
    </div>
  );
}

export function GifFrameControls({
  playback,
  locked = false,
  onSeek,
  markers = [],
}: {
  playback: ReturnType<typeof useGifPlayback>;
  locked?: boolean;
  onSeek: (index: number) => void;
  markers?: { id: string; frameIndex: number; label: string }[];
}) {
  if (!playback.active || !playback.clock) return null;
  const { clock, frameIndex } = playback;
  return (
    <section className={styles.controls} aria-label="GIF 播放与帧定位">
      <button
        type="button"
        disabled={!playback.ready || locked}
        onClick={playback.toggle}
        aria-label={playback.playing ? '暂停 GIF' : '播放 GIF'}
      >
        {playback.playing ? '暂停' : '播放'}
      </button>
      <button
        type="button"
        aria-label="上一帧"
        disabled={locked || !playback.ready || frameIndex === 0}
        onClick={() => onSeek(frameIndex - 1)}
      >
        ‹
      </button>
      <output aria-live={playback.playing ? 'off' : 'polite'}>
        第 {frameIndex + 1} / {clock.frameCount} 帧 · {((playback.frame?.timestampMs ?? 0) / 1000).toFixed(2)}s
      </output>
      <button
        type="button"
        aria-label="下一帧"
        disabled={locked || !playback.ready || frameIndex === clock.frameCount - 1}
        onClick={() => onSeek(frameIndex + 1)}
      >
        ›
      </button>
      <input
        type="range"
        min={0}
        max={clock.frameCount - 1}
        step={1}
        value={frameIndex}
        aria-label="GIF 帧位置"
        disabled={locked || !playback.ready}
        onChange={(event) => onSeek(Number(event.target.value))}
      />
      <label>
        <input
          type="checkbox"
          checked={playback.repeat}
          disabled={locked}
          onChange={(event) => playback.setRepeat(event.target.checked)}
        />
        循环
      </label>
      <select
        aria-label="GIF 播放速度"
        value={playback.speed}
        onChange={(event) => playback.setSpeed(Number(event.target.value))}
      >
        <option value={0.5}>0.5×</option>
        <option value={1}>1×</option>
      </select>
      {markers.length ? (
        <div role="group" className={styles.markers} aria-label="GIF 批注位置">
          {markers.map((marker) => (
            <button key={marker.id} type="button" disabled={locked} onClick={() => onSeek(marker.frameIndex)}>
              {marker.label} · 第 {marker.frameIndex + 1} 帧
            </button>
          ))}
        </div>
      ) : null}
    </section>
  );
}
