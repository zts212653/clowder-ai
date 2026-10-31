import { reviewMediaControl } from './review-media-styles';
import type { useArtworkViewport } from './useArtworkViewport';

export function ArtworkViewportControls({ viewport }: { viewport: ReturnType<typeof useArtworkViewport> }) {
  return (
    <fieldset className="flex flex-wrap items-center justify-center gap-1">
      <legend className="sr-only">作品缩放和平移</legend>
      <button type="button" className={reviewMediaControl} onClick={viewport.fit}>
        适合窗口
      </button>
      <button type="button" className={reviewMediaControl} onClick={viewport.actual}>
        100%
      </button>
      <button type="button" className={reviewMediaControl} aria-label="缩小作品" onClick={viewport.zoomOut}>
        −
      </button>
      <output className="min-w-10 text-center text-xs text-cafe-muted" aria-label="当前缩放">
        {Math.round(viewport.renderedScale * 100)}%
      </output>
      <button type="button" className={reviewMediaControl} aria-label="放大作品" onClick={viewport.zoomIn}>
        ＋
      </button>
      <button
        type="button"
        className={reviewMediaControl}
        aria-pressed={viewport.panMode}
        onClick={() => viewport.setPanMode(!viewport.panMode)}
      >
        平移
      </button>
    </fieldset>
  );
}
