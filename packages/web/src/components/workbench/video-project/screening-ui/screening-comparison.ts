import type { VideoProjectScreening } from '@cat-cafe/shared';
import { useEffect, useMemo, useState } from 'react';
import type { VideoProjectTarget } from '../../video-project-surface';

export function earlierRegisteredScreenings(screenings: readonly VideoProjectScreening[], rightId: string | undefined) {
  const index = screenings.findIndex((item) => item.id === rightId);
  return index > 0 ? screenings.slice(0, index) : [];
}

/** Comparison belongs to one explicit frozen right/return position, never just the reusable surface ID. */
export function useScreeningComparison(
  target: VideoProjectTarget,
  screenings: readonly VideoProjectScreening[] | undefined,
  rightId: string | undefined,
) {
  const navigationKey = JSON.stringify([
    target.contentRef,
    target.screeningId ?? null,
    rightId ?? null,
    target.position?.pts ?? null,
    target.position?.requestId ?? null,
  ]);
  const [choice, setChoice] = useState<{ navigationKey: string; rightId: string; leftId: string } | null>(null);
  const earlier = useMemo(() => earlierRegisteredScreenings(screenings ?? [], rightId), [screenings, rightId]);
  // Render-time scope checks also prevent an invalid pair mounting before this effect runs.
  useEffect(() => {
    setChoice((current) =>
      current?.navigationKey === navigationKey &&
      current.rightId === rightId &&
      earlier.some((item) => item.id === current.leftId)
        ? current
        : null,
    );
  }, [navigationKey, rightId, earlier]);
  const compareId =
    choice?.navigationKey === navigationKey &&
    choice.rightId === rightId &&
    earlier.some((item) => item.id === choice.leftId)
      ? choice.leftId
      : null;
  const setCompareId = (leftId: string | null) => {
    setChoice(
      leftId && rightId && earlier.some((item) => item.id === leftId) ? { navigationKey, rightId, leftId } : null,
    );
  };
  return { compareId, setCompareId };
}
