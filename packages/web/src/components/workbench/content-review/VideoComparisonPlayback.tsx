'use client';
import type { ReviewedMediaAsset, WorkContextRecord, WorkReference, WorkVideoContext } from '@cat-cafe/shared';
import { useRef, useState } from 'react';
import { ArtworkVideoPlayback } from '@/components/content-review/ArtworkVideoPlayback';
import videoStyles from '@/components/content-review/artwork-video-fullscreen.module.css';
import { tickToBrowserTime } from '@/components/content-review/review-geometry';
import { useArtworkVideoFullscreen } from '@/components/content-review/useArtworkVideoFullscreen';
import { API_URL } from '@/utils/api-client';
import { useVideoWorkContext } from './useVideoWorkContext';
import { VideoStoryAlignment } from './VideoStoryAlignment';

type Story = WorkVideoContext['story'][number];

export function VideoComparisonPlayback({
  asset,
  reference,
  rightContext,
  sequential,
  leftActive,
  onShowRight,
  onAlignRight,
}: {
  asset: ReviewedMediaAsset;
  reference: WorkReference;
  rightContext: WorkContextRecord | null;
  sequential: boolean;
  leftActive: boolean;
  onShowRight: () => void;
  onAlignRight: (story: Story) => void;
}) {
  const player = useRef<HTMLVideoElement>(null);
  const container = useRef<HTMLDivElement>(null);
  const fullscreen = useArtworkVideoFullscreen(container, player);
  const [seconds, setSeconds] = useState(0);
  const [paused, setPaused] = useState(true);
  const [leftSeek, setLeftSeek] = useState<number | null>(null);
  const left = useVideoWorkContext(asset.contentRef, asset.ownerRevision);
  const matching =
    left.record?.reference.contentRef === reference.contentRef &&
    left.record.reference.ownerRevision === asset.ownerRevision &&
    rightContext?.reference.contentRef === reference.contentRef &&
    rightContext.reference.ownerRevision === reference.ownerRevision;
  return (
    <>
      {!sequential || leftActive ? (
        <div ref={container} data-artwork-video-player className={`${videoStyles.player} min-w-0 bg-cafe-surface`}>
          <div data-artwork-video-viewport>
            <div data-artwork-video-stage>
              {/* biome-ignore lint/a11y/useMediaCaption: Original delivered video may not have external captions. */}
              <video
                ref={player}
                playsInline
                preload="metadata"
                className="max-h-[50vh] w-full min-h-0 bg-black object-contain fullscreen:max-h-none"
                onLoadedMetadata={(event) => {
                  if (leftSeek !== null) event.currentTarget.currentTime = leftSeek;
                }}
                onTimeUpdate={(event) => setSeconds(event.currentTarget.currentTime)}
                onPlay={() => setPaused(false)}
                onPause={() => setPaused(true)}
                aria-label={`对比原件第 ${asset.ownerRevision} 版`}
                src={`${API_URL}/api/content-publications/${encodeURIComponent(asset.contentRef)}/media/${asset.ownerRevision}`}
              />
            </div>
          </div>
          {asset.media.kind === 'video' ? (
            <div data-testid="artwork-video-timeline" className="shrink-0 px-3 py-2 text-xs">
              <ArtworkVideoPlayback
                video={player}
                seconds={seconds}
                paused={paused}
                duration={tickToBrowserTime(asset.media.startTick + asset.media.durationTicks, asset.media)}
                fullscreen={fullscreen}
                seekTo={(next) => {
                  setLeftSeek(next);
                  if (player.current && player.current.readyState >= 1) player.current.currentTime = next;
                }}
              />
            </div>
          ) : null}
        </div>
      ) : null}
      <p className="p-2 text-xs text-cafe-muted">{sequential ? '先看左版，再看右版。' : '两侧按各自原片播放。'}</p>
      {left.error ? (
        <p role="alert" className="p-2 text-xs text-cafe-error">
          对比版故事线暂时无法读取。
        </p>
      ) : null}
      <VideoStoryAlignment
        key={`${left.record?.metadataRevision}:${rightContext?.metadataRevision}`}
        leftChapters={matching ? left.record?.context.chapters : []}
        rightChapters={matching ? rightContext?.context.chapters : []}
        left={matching ? (left.record?.context.story ?? []) : []}
        right={matching ? (rightContext?.context.story ?? []) : []}
        onAlign={(leftStory, rightStory) => {
          if (asset.media.kind !== 'video' || leftStory.streamId !== asset.media.streamId) return;
          const seconds = tickToBrowserTime(leftStory.startPts, asset.media);
          setLeftSeek(seconds);
          if (player.current && player.current.readyState >= 1) {
            player.current.pause();
            player.current.currentTime = seconds;
          }
          if (sequential) onShowRight();
          onAlignRight(rightStory);
        }}
      />
    </>
  );
}
