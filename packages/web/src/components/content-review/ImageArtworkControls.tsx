import type { ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { useShellCopy } from '@/components/shell/shell-copy';
import { ArtworkAnnotationToolbar } from './ArtworkAnnotationToolbar';
import { useArtworkLightboxScope, useFloatingArtworkPresentation } from './ArtworkLightboxScope';
import toolbarStyles from './artwork-annotation-toolbar.module.css';
import styles from './image-artwork.module.css';
import { imageArtworkCopy } from './image-artwork.shell-copy';
import type { ReviewCanvasMode } from './ReviewCanvasToolbar';
import type { useArtworkViewport } from './useArtworkViewport';

/** Image actions share the measured canvas; viewport and annotation authority remain with its owner. */
export function ImageArtworkControls({
  unifiedActions = false,
  mode,
  canAnnotate,
  canMarkup,
  onModeChange,
  viewport,
  discussionCount,
  onOpenDiscussion,
  wholeWorkAction,
  children,
}: {
  unifiedActions?: boolean;
  mode: ReviewCanvasMode;
  canAnnotate: boolean;
  canMarkup: boolean;
  onModeChange: (mode: ReviewCanvasMode) => void;
  viewport: ReturnType<typeof useArtworkViewport>;
  src: string | null;
  download?: { src: string | null; filename: string };
  discussionCount: number;
  onOpenDiscussion: () => void;
  wholeWorkAction?: ReactNode;
  children: ReactNode;
}) {
  const t = useShellCopy(imageArtworkCopy);
  const floating = useFloatingArtworkPresentation();
  const toolsSlot = useArtworkLightboxScope()?.toolsSlot;
  const tools = (
    <div
      className={floating ? toolbarStyles.placement : styles.tools}
      data-review-mode={mode}
      style={
        !floating && mode !== 'markup' && typeof viewport.stageStyle.height === 'number'
          ? { top: `clamp(44px, ${viewport.mediaBottom + 12}px, calc(100% - 60px))`, bottom: 'auto' }
          : undefined
      }
    >
      {mode === 'markup' ? (
        children
      ) : (
        <section aria-label={t.tools} data-review-mode={mode}>
          <ArtworkAnnotationToolbar
            label={t.modes}
            tools={[
              {
                id: 'select',
                label: t.circle,
                icon: 'rectangle',
                disabled: !canAnnotate,
                active: mode === 'comment',
                onSelect: () => onModeChange(mode === 'comment' ? 'view' : 'comment'),
              },
              {
                id: 'brush',
                label: t.brush,
                icon: 'brush',
                disabled: !canMarkup,
                onSelect: () => onModeChange('markup'),
              },
            ]}
          />
        </section>
      )}
    </div>
  );
  return (
    <>
      {!unifiedActions ? (
        <div className={styles.viewOptions}>
          <details className={styles.menu}>
            <summary aria-label={t.viewport}>
              <span role="status" aria-label={t.scale}>
                {Math.round(viewport.renderedScale * 100)}%
              </span>
              <span aria-hidden>⌄</span>
            </summary>
            <div className={styles.menuBody}>
              <button type="button" onClick={viewport.fit}>
                {t.fit}
              </button>
              <button type="button" onClick={viewport.actual}>
                100%
              </button>
              <button type="button" aria-label={t.zoomOutLabel} onClick={viewport.zoomOut}>
                {t.zoomOut}
              </button>
              <button type="button" aria-label={t.zoomInLabel} onClick={viewport.zoomIn}>
                {t.zoomIn}
              </button>
              <button
                type="button"
                aria-pressed={viewport.panMode}
                onClick={() => viewport.setPanMode(!viewport.panMode)}
              >
                {t.pan}
              </button>
            </div>
          </details>
          {wholeWorkAction}
          <button type="button" aria-label={t.discussionLabel} onClick={onOpenDiscussion}>
            {t.discussion}
            {discussionCount ? ` · ${discussionCount}` : ''}
          </button>
        </div>
      ) : null}
      {floating && toolsSlot ? createPortal(tools, toolsSlot) : tools}
    </>
  );
}
