'use client';
import type { ThreadArtifactDTO } from '@cat-cafe/shared';
import { useState } from 'react';
import { ShellGlyph } from '@/components/shell/ShellIcons';
import { useShellCopy } from '@/components/shell/shell-copy';
import { API_URL } from '@/utils/api-client';
import { resolveAssetUrl } from './artifact-view';
import { useNearWorkViewport } from './useNearWorkViewport';
import { useWorkCardDescription, type WorkCardDescription, workVideoPoster } from './useWorkCardDescription';
import { worksPanelCopy } from './works-panel.shell-copy';

export function WorkVideoPreview({
  artifact,
  description,
  pending,
}: {
  artifact: ThreadArtifactDTO;
  description?: WorkCardDescription | null;
  pending?: boolean;
}) {
  const { ref, near } = useNearWorkViewport<HTMLSpanElement>();
  const read = useWorkCardDescription(artifact.work, near && description === undefined);
  const poster = workVideoPoster(description ?? read.description);
  const url = resolveAssetUrl(artifact.url, API_URL);
  const t = useShellCopy(worksPanelCopy);
  return (
    <span ref={ref} className="work-cover work-cover-video">
      {near && url && !read.loading && !pending ? (
        <VideoFrame key={`${url}:${poster ?? ''}`} url={url} poster={poster} label={t.filters.video} />
      ) : (
        <>
          <span className="work-cover-play">
            <ShellGlyph name="play" className="h-5 w-5" />
          </span>
          <span className="work-cover-badge work-cover-video-badge">
            <ShellGlyph name="play" className="h-3 w-3" />
            {t.filters.video}
          </span>
        </>
      )}
    </span>
  );
}

function VideoFrame({ url, poster, label }: { url: string; poster?: string | null; label: string }) {
  const [failed, setFailed] = useState(false);
  const [ready, setReady] = useState(false);
  const [duration, setDuration] = useState<number>();
  const [posterFailed, setPosterFailed] = useState(false);
  const cover = poster && !posterFailed ? poster : undefined;
  const time =
    duration === undefined
      ? null
      : `${Math.floor(duration / 60)}:${String(Math.floor(duration % 60)).padStart(2, '0')}`;
  return (
    <>
      {!failed && (
        <video
          key={cover ?? 'frame'}
          src={url}
          poster={cover}
          muted
          playsInline
          preload="metadata"
          aria-hidden="true"
          tabIndex={-1}
          className={cover || ready ? 'work-cover-frame' : 'work-cover-frame work-cover-frame-pending'}
          onLoadedMetadata={(event) => {
            const video = event.currentTarget;
            if (Number.isFinite(video.duration) && video.duration > 0) {
              setDuration(video.duration);
              if (!cover) video.currentTime = Math.min(4, video.duration * 0.3);
            }
          }}
          onSeeked={() => setReady(true)}
          onLoadedData={(event) => {
            if (cover || event.currentTarget.currentTime > 0) setReady(true);
          }}
          onError={() => {
            setFailed(true);
            setDuration(undefined);
          }}
        />
      )}
      {cover && (
        // biome-ignore lint/performance/noImgElement: covers are already published static assets, with explicit error recovery.
        <img
          className="work-cover-poster"
          src={cover}
          alt=""
          onError={() => {
            setPosterFailed(true);
            setReady(false);
          }}
        />
      )}
      {(!cover && !ready) || failed ? (
        <span className="work-cover-play">
          <ShellGlyph name="play" className="h-5 w-5" />
        </span>
      ) : null}
      <span className="work-cover-badge work-cover-video-badge">
        <ShellGlyph name="play" className="h-3 w-3" />
        {time ?? label}
      </span>
    </>
  );
}
