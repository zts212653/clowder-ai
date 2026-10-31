'use client';
import type { ThreadArtifactDTO } from '@cat-cafe/shared';
import { useState } from 'react';
import { useShellCopy } from '@/components/shell/shell-copy';
import { API_URL } from '@/utils/api-client';
import { resolveAssetUrl } from './artifact-view';
import { useNearWorkViewport } from './useNearWorkViewport';
import { WorkCoverIcon } from './WorkCoverIcon';
import { worksPanelCopy } from './works-panel.shell-copy';

const heights = [10, 18, 28, 16, 38, 46, 32, 20, 40, 29, 14, 33, 42, 24, 12, 22, 34, 17];
export function WorkAudioPreview({ artifact }: { artifact: ThreadArtifactDTO }) {
  const { ref, near } = useNearWorkViewport<HTMLSpanElement>();
  const [duration, setDuration] = useState<{ url: string; seconds: number }>();
  const url = resolveAssetUrl(artifact.url, API_URL);
  const t = useShellCopy(worksPanelCopy);
  const seconds = duration?.url === url ? duration?.seconds : undefined;
  const time =
    seconds === undefined ? '' : `${Math.floor(seconds / 60)}:${String(Math.floor(seconds % 60)).padStart(2, '0')}`;
  return (
    <span ref={ref} className="work-cover work-cover-audio">
      <span className="work-cover-wave" aria-hidden="true">
        {heights.map((height) => (
          <i key={height} style={{ height }} />
        ))}
      </span>
      {near && url ? (
        // biome-ignore lint/a11y/useMediaCaption: metadata-only duration probe; this element never plays.
        <audio
          src={url}
          preload="metadata"
          aria-hidden="true"
          tabIndex={-1}
          onLoadedMetadata={(event) => {
            const seconds = event.currentTarget.duration;
            if (Number.isFinite(seconds) && seconds > 0) setDuration({ url, seconds });
          }}
        />
      ) : null}
      <span className="work-cover-badge">
        <WorkCoverIcon kind="audio" />
        {t.filters.audio}
        {time && ` ${time}`}
      </span>
    </span>
  );
}
