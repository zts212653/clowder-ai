'use client';
import type { RoutingContextReadModelV1 } from '@cat-cafe/shared';
import { useEffect, useState } from 'react';
import { memberSignalDeadline } from './member-projection';

// A read-only deadline tick prevents an expired owner fact remaining visibly live.
export function useMemberClock(
  model:
    | (Pick<RoutingContextReadModelV1, 'signalEvents'> &
        Partial<Pick<RoutingContextReadModelV1, 'preferenceRevisions'>>)
    | null,
) {
  const [now, setNow] = useState(Date.now);
  // biome-ignore lint/correctness/useExhaustiveDependencies: now schedules the next deadline after each read-only tick.
  useEffect(() => {
    const current = Date.now();
    const deadlines =
      model?.signalEvents.flatMap((event) => (event.eventType === 'asserted' ? [memberSignalDeadline(event)] : [])) ??
      [];
    const reviews =
      model?.preferenceRevisions?.flatMap((revision) =>
        revision.lifecycle === 'active' && revision.reviewAfter !== undefined ? [revision.reviewAfter] : [],
      ) ?? [];
    const next = Math.min(current + 60_000, ...[...deadlines, ...reviews].filter((deadline) => deadline > current));
    const timer = window.setTimeout(() => setNow(Date.now()), Math.max(1, next - current));
    return () => window.clearTimeout(timer);
  }, [model, now]);
  // A new owner snapshot must use its arrival time, even before the timer fires.
  return Date.now();
}
