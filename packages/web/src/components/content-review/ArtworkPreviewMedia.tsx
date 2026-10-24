import { useRef, useState } from 'react';
import { ArtworkActions } from './ArtworkActions';
import { ArtworkGalleryArrows } from './ArtworkGalleryNavigation';
import { ArtworkPreviewVideo } from './ArtworkPreviewVideo';
import type { ArtworkGallery } from './artwork-gallery';
import { useArtworkViewport } from './useArtworkViewport';
/** Unadmitted/remote previews have presentation controls, never a fabricated review or Chat sender. */
export function ArtworkPreviewMedia({
  url,
  title,
  video,
  gallery,
  showActions = true,
}: {
  url: string;
  title: string;
  video: boolean;
  gallery?: ArtworkGallery;
  showActions?: boolean;
}) {
  const root = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ width: 0, height: 0 });
  const viewport = useArtworkViewport(root, size, 1, false, (gallery?.items.length ?? 0) > 1);
  return (
    <div
      ref={root}
      className="relative flex min-h-0 flex-1 items-center justify-center overflow-hidden"
      {...viewport.handlers}
    >
      {showActions ? (
        <ArtworkActions
          root={root}
          src={url}
          originalUrl={url}
          filename={title}
          width={size.width}
          height={size.height}
          mediaType={video ? 'video' : 'image'}
          viewport={viewport}
        />
      ) : null}
      {video ? (
        <ArtworkPreviewVideo url={url} stageStyle={viewport.stageStyle} onSize={setSize} />
      ) : (
        <img
          src={url}
          alt={title}
          style={viewport.stageStyle}
          className="object-contain"
          onLoad={(event) =>
            setSize({ width: event.currentTarget.naturalWidth, height: event.currentTarget.naturalHeight })
          }
        />
      )}
      {gallery ? <ArtworkGalleryArrows gallery={gallery} /> : null}
    </div>
  );
}
