import type { ArtifactReviewAnnotation } from '@cat-cafe/shared';
import { reviewMediaControl } from './review-media-styles';

export function ReviewAnnotationNavigation({
  annotations,
  activeId,
  onActive,
}: {
  annotations: ArtifactReviewAnnotation[];
  activeId: string | null;
  onActive: (id: string) => void;
}) {
  if (!annotations.length) return null;
  return (
    <section className="flex max-w-44 gap-1 overflow-x-auto" aria-label="标注定位">
      {annotations.map((annotation, index) => (
        <button
          key={annotation.id}
          type="button"
          className={reviewMediaControl}
          aria-pressed={annotation.id === activeId}
          onClick={() => onActive(annotation.id)}
        >
          标注 {index + 1}
        </button>
      ))}
    </section>
  );
}
