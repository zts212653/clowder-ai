import { ArtworkViewportControls } from './ArtworkViewportControls';
import { ReviewMediaControls } from './ReviewMediaControls';
import styles from './review-workspace.module.css';
import type { useArtworkViewport } from './useArtworkViewport';

export function ArtworkMediaFooter({
  viewport,
  controls,
  discussionCount,
  onOpenDiscussion,
}: {
  viewport: ReturnType<typeof useArtworkViewport>;
  controls: Parameters<typeof ReviewMediaControls>[0];
  discussionCount: number;
  onOpenDiscussion: () => void;
}) {
  return (
    <div className={styles.mediaFooter}>
      <ArtworkViewportControls viewport={viewport} />
      <ReviewMediaControls {...controls} />
      <button type="button" className={styles.badgeButton} onClick={onOpenDiscussion} aria-label="打开作品讨论">
        讨论 <span className={styles.count}>{discussionCount}</span>
      </button>
    </div>
  );
}
