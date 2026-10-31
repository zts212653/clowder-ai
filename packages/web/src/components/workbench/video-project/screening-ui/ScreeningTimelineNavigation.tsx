import type { VideoProjectDocumentV1, VideoProjectSegment } from '@cat-cafe/shared';
import Image from 'next/image';
import { API_URL } from '@/utils/api-client';
import { projectPath } from '../api';
import styles from '../VideoProjectReviewSurface.module.css';
import { useScreeningCopy } from './screening.shell-copy';

/** Scene and shot buttons navigate the selected input clock, never the latest head's timeline. */
export function ScreeningTimelineNavigation({
  timeline,
  current,
  onSeek,
  assets,
  contentRef,
  ownerRevision,
}: {
  timeline: VideoProjectDocumentV1['timeline'];
  current: VideoProjectSegment | undefined;
  onSeek: (tick: number) => void;
  assets: VideoProjectDocumentV1['assets'];
  contentRef: string;
  ownerRevision: number;
}) {
  const t = useScreeningCopy();
  return (
    <>
      <nav aria-label={t.scenes} className={`${styles.scenes} mt-4 gap-1`}>
        {timeline.scenes.map((scene, index) => {
          const first = timeline.segments.find((segment) => segment.sceneId === scene.id);
          return (
            <button
              type="button"
              key={scene.id}
              disabled={!first}
              title={scene.label}
              aria-label={`${index + 1} · ${scene.label}`}
              aria-current={current?.sceneId === scene.id ? 'true' : undefined}
              className={`min-w-0 rounded px-2 py-1 text-xs ${current?.sceneId === scene.id ? 'bg-cafe-surface-sunken ring-1 ring-cafe-subtle' : 'bg-cafe-surface'}`}
              onClick={() => first && onSeek(first.startTick)}
            >
              {index + 1}
            </button>
          );
        })}
      </nav>
      <nav aria-label={t.shots} className="mt-2 flex gap-2 overflow-x-auto pb-2">
        {timeline.segments
          .filter((segment) => current && segment.sceneId === current.sceneId)
          .map((segment) => {
            const visual = segment.visuals.find((item) => item.assetVersionRef);
            const version = assets
              .flatMap((asset) => asset.versions)
              .find((item) => item.id === visual?.assetVersionRef);
            return (
              <button
                type="button"
                key={segment.id}
                title={segment.label}
                aria-current={current?.id === segment.id ? 'true' : undefined}
                className={`w-24 shrink-0 overflow-hidden rounded-lg border text-left text-xs ${current?.id === segment.id ? 'border-cafe-accent bg-cafe-surface' : 'border-cafe-subtle'}`}
                onClick={() => onSeek(segment.startTick)}
              >
                {version?.mediaType.toLowerCase() === 'image/png' ? (
                  <Image
                    unoptimized
                    crossOrigin="use-credentials"
                    width={96}
                    height={54}
                    alt={`${segment.label} · ${t.thumbnail}`}
                    src={`${API_URL}${projectPath(contentRef)}/assets/${encodeURIComponent(version.id)}?ownerRevision=${ownerRevision}`}
                    className="h-14 w-full bg-cafe-canvas object-cover"
                    style={{ transform: `rotate(${version.rotation ?? 0}deg)` }}
                  />
                ) : (
                  <span className="grid h-14 place-items-center bg-cafe-canvas text-cafe-muted">—</span>
                )}
                <span className="block truncate px-2 py-1 font-semibold">{segment.label}</span>
              </button>
            );
          })}
      </nav>
    </>
  );
}
