import type { ThreadArtifactDTO } from '@cat-cafe/shared';
import { WorkGalleryCard } from '../artifacts/WorkGalleryCard';

/** Home supplies its compact layout and return focus; content facts and operations are shared. */
export function WorkCard({
  artifact,
  summary,
  metadata,
  onSelect,
  current,
}: {
  artifact: ThreadArtifactDTO;
  summary: boolean;
  metadata: string;
  worktreeId: string | null;
  onSelect: (card: HTMLButtonElement) => void;
  current?: boolean;
}) {
  return (
    <div className="home-work-entry" aria-current={current || undefined}>
      <WorkGalleryCard
        artifact={artifact}
        metadata={metadata}
        onSelect={onSelect}
        current={current}
        compact={summary}
      />
    </div>
  );
}
