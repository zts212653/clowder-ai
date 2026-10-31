'use client';
import { Fragment, type ReactNode } from 'react';
import { useArtworkLightboxScope, useFloatingArtworkPresentation } from './ArtworkLightboxScope';
import styles from './artwork-annotation-toolbar.module.css';
import { type ReviewIconName, ReviewToolbarIcon } from './ReviewToolbarIcon';

interface AnnotationTool {
  readonly id: string;
  readonly label: string;
  readonly icon: ReviewIconName;
  readonly disabled?: boolean;
  readonly active?: boolean;
  readonly expanded?: boolean;
  readonly onSelect: () => void;
}

/** One named tool group for both image and video annotations; playback belongs to the player. */
export function ArtworkAnnotationToolbar({
  label,
  tools,
  more,
}: {
  label: string;
  tools: readonly AnnotationTool[];
  more?: { readonly label: string; readonly children: ReactNode };
}) {
  // Image and video controls portal this toolbar into the floating composer slot exactly when both hold.
  // That panel scrolls, so an upward menu would be clipped above its top edge and fall onto the gallery strip.
  const floating = useFloatingArtworkPresentation();
  const toolsSlot = useArtworkLightboxScope()?.toolsSlot;
  const menuPlacement = floating && toolsSlot ? 'below' : 'above';
  return (
    <div className={styles.dock} role="toolbar" aria-label={label} data-testid="artwork-annotation-toolbar">
      {tools.map((tool, index) => (
        <Fragment key={tool.id}>
          {index ? <span className={styles.separator} aria-hidden /> : null}
          <button
            type="button"
            className={styles.tool}
            disabled={tool.disabled}
            aria-pressed={tool.active}
            aria-expanded={tool.expanded}
            onClick={tool.onSelect}
          >
            <ReviewToolbarIcon name={tool.icon} />
            {tool.label}
          </button>
        </Fragment>
      ))}
      {more ? (
        <details className={styles.more}>
          <summary aria-label={more.label}>
            <ReviewToolbarIcon name="more" />
          </summary>
          <div
            className={menuPlacement === 'below' ? `${styles.menu} ${styles.menuBelow}` : styles.menu}
            data-menu-placement={menuPlacement}
          >
            {more.children}
          </div>
        </details>
      ) : null}
    </div>
  );
}
