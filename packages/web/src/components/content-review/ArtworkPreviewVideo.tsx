import { type CSSProperties, useRef, useState } from 'react';
import { ArtworkVideoPlayback } from './ArtworkVideoPlayback';
import styles from './artwork-video-fullscreen.module.css';
import { ContentMediaElement } from './ContentMediaElement';
import { useArtworkVideoFullscreen } from './useArtworkVideoFullscreen';

/** A preview keeps the same player/fullscreen behavior without inventing a review owner. */
export function ArtworkPreviewVideo({
  url,
  stageStyle,
  onSize,
}: {
  url: string;
  stageStyle: CSSProperties;
  onSize: (size: { width: number; height: number }) => void;
}) {
  const player = useRef<HTMLDivElement>(null),
    video = useRef<HTMLVideoElement>(null);
  const [seconds, setSeconds] = useState(0),
    [duration, setDuration] = useState(0),
    [paused, setPaused] = useState(true);
  const fullscreen = useArtworkVideoFullscreen(player, video);
  return (
    <div ref={player} data-artwork-video-player className={`flex h-full min-h-0 w-full flex-col ${styles.player}`}>
      <div data-artwork-video-viewport className="flex min-h-0 flex-1 items-center justify-center overflow-hidden">
        <div data-artwork-video-stage className="relative" style={stageStyle}>
          <ContentMediaElement
            kind="video"
            src={url}
            videoRef={video}
            className="absolute inset-0 h-full w-full object-contain"
            videoProps={{
              onLoadedMetadata: (event) => {
                const node = event.currentTarget;
                onSize({ width: node.videoWidth, height: node.videoHeight });
                setDuration(Number.isFinite(node.duration) ? node.duration : 0);
                setSeconds(node.currentTime);
                setPaused(node.paused);
              },
              onTimeUpdate: (event) => setSeconds(event.currentTarget.currentTime),
              onPlay: () => setPaused(false),
              onPause: () => setPaused(true),
            }}
          />
        </div>
      </div>
      <div data-testid="artwork-video-timeline" className="w-full shrink-0 px-3 py-2 text-xs">
        <ArtworkVideoPlayback
          video={video}
          seconds={seconds}
          duration={duration}
          paused={paused}
          seekTo={(value) => {
            if (video.current) video.current.currentTime = value;
          }}
          fullscreen={fullscreen}
        />
      </div>
    </div>
  );
}
