'use client';
import type { ThreadArtifactDTO } from '@cat-cafe/shared';
import { useEffect, useRef, useState } from 'react';
import { ShellGlyph } from '@/components/shell/ShellIcons';
import { useShellCopy } from '@/components/shell/shell-copy';
import { API_URL } from '@/utils/api-client';
import { resolveAssetUrl } from './artifact-view';
import { useNearWorkViewport } from './useNearWorkViewport';
import { useWorkCardDescription, type WorkCardDescription, workVideoDemo } from './useWorkCardDescription';
import { requestWorkVideoFrame, type WorkVideoFrame } from './work-video-frame';
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
  const { ref, near } = useNearWorkViewport<HTMLSpanElement>({ rootMargin: '0px', once: false });
  const read = useWorkCardDescription(artifact.work, near && description === undefined);
  const demo = workVideoDemo(description ?? read.description);
  const url = resolveAssetUrl(artifact.url, API_URL);
  const t = useShellCopy(worksPanelCopy);
  return (
    <span ref={ref} className="work-cover work-cover-video">
      <VideoFrame
        key={`${url}:${demo?.poster ?? ''}`}
        url={url}
        poster={demo?.poster}
        duration={demo?.durationSeconds}
        enabled={near && (description !== undefined || !read.loading) && !pending}
        label={t.filters.video}
      />
    </span>
  );
}

function VideoFrame({
  url,
  poster,
  duration,
  enabled,
  label,
}: {
  url?: string;
  poster?: string;
  duration?: number;
  enabled: boolean;
  label: string;
}) {
  const [frame, setFrame] = useState<WorkVideoFrame | null>(null);
  const [posterFailed, setPosterFailed] = useState(false);
  const cover = poster && !posterFailed ? poster : undefined;
  const canvas = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    if (!enabled || !url || cover || frame) return;
    return requestWorkVideoFrame(url, setFrame);
  }, [enabled, url, cover, frame]);
  useEffect(() => {
    if (!frame || !canvas.current) return;
    canvas.current.width = frame.canvas.width;
    canvas.current.height = frame.canvas.height;
    canvas.current.getContext('2d')?.drawImage(frame.canvas, 0, 0);
  }, [frame]);
  const seconds = frame?.duration ?? duration;
  const time =
    seconds !== undefined && Number.isFinite(seconds) && seconds > 0
      ? `${Math.floor(seconds / 60)}:${String(Math.floor(seconds % 60)).padStart(2, '0')}`
      : label;
  return (
    <>
      {frame && <canvas ref={canvas} className="work-cover-frame" aria-hidden="true" tabIndex={-1} />}
      {cover && enabled && (
        // biome-ignore lint/performance/noImgElement: exact registered cut, with fallback to a queued frame.
        <img className="work-cover-poster" src={cover} alt="" onError={() => setPosterFailed(true)} />
      )}
      {!cover && !frame && (
        <span className="work-cover-play">
          <ShellGlyph name="play" className="h-5 w-5" />
        </span>
      )}
      <span className="work-cover-badge work-cover-video-badge">
        <ShellGlyph name="play" className="h-3 w-3" />
        {time}
      </span>
    </>
  );
}
