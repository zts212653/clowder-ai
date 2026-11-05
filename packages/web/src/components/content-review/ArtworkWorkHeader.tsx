'use client';
import type { ReactNode } from 'react';
import { useShellCopy } from '@/components/shell/shell-copy';
import { useArtworkChrome } from './ArtworkChrome';
import { useArtworkGallery } from './ArtworkGalleryScope';
import styles from './artwork-actions.module.css';
import { artworkActionsCopy } from './artwork-actions.shell-copy';

/** One header in the explicit artwork work mode; all version and host actions retain their original owners. */
export function ArtworkWorkHeader({
  title,
  versionControl,
  onReturn,
  fullWindowAction,
}: {
  title?: string;
  versionControl?: ReactNode;
  onReturn: () => void;
  fullWindowAction?: { active: boolean; onToggle: () => void };
}) {
  const copy = useShellCopy(artworkActionsCopy);
  const chrome = useArtworkChrome();
  const gallery = useArtworkGallery();
  return (
    <header
      data-testid="artwork-header"
      className={`${styles.workHeader} min-h-11 shrink-0 border-b border-cafe-subtle px-3 py-2`}
    >
      <div className={styles.workHeaderRow}>
        <button
          type="button"
          onClick={onReturn}
          className="shrink-0 text-xs text-cafe-secondary"
          data-testid="artwork-work-mode-return"
        >
          ‹ {copy.returnToChat}
        </button>
        <h2 className={`${styles.workTitle} min-w-0 truncate text-sm font-semibold`} title={title}>
          {title}
        </h2>
        {gallery && gallery.items.length > 1 ? (
          <span className="shrink-0 text-xs tabular-nums text-cafe-muted" data-testid="artwork-gallery-position">
            {gallery.index + 1} / {gallery.items.length}
          </span>
        ) : null}
        <div className={`${styles.workVersion} shrink-0 text-xs`}>
          {versionControl ?? (
            <select aria-label={copy.versionLabel} disabled value="1" className="bg-transparent">
              <option value="1">{copy.version}</option>
            </select>
          )}
        </div>
        <div className="ml-auto flex shrink-0 items-center gap-2">
          {fullWindowAction ? (
            <button
              type="button"
              onClick={fullWindowAction.onToggle}
              aria-label={fullWindowAction.active ? copy.expandChat : copy.fullWindow}
              data-testid={
                fullWindowAction.active ? 'f307-artifact-exit-full-window' : 'f307-artifact-enter-full-window'
              }
              className="px-2 text-sm"
            >
              ⤢
            </button>
          ) : null}
          <div ref={chrome?.setActions} className="flex items-center gap-2" />
        </div>
      </div>
    </header>
  );
}
