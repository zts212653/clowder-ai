import {
  type CollectiveHostContextInit,
  type CollectiveHostProjectAttentionFocus,
  collectiveHostProjectAttentionFocusSchema,
} from '@cat-cafe/shared';
import { useCallback, useEffect, useRef } from 'react';
import type { ClientSnapshot } from './client-types.js';

export type ProjectAttentionFocus = {
  roadmapId: string;
  channelId: string;
  attention: 'triage' | 'date_suggestion' | 'overdue' | 'work_dates';
  workId?: string;
};
export function useHostProjectAttentionContext(input: {
  context: { current: { bridge?: CollectiveHostContextInit; contextId: string; revision: number } };
  snapshot: ClientSnapshot;
  onFocus(focus: ProjectAttentionFocus | { workId: string; channelId: string; eventId: string }): void;
}) {
  const latest = useRef(input.snapshot);
  latest.current = input.snapshot;
  const pending = useRef<CollectiveHostProjectAttentionFocus>();
  const apply = useCallback(
    (focus: CollectiveHostProjectAttentionFocus) => {
      const context = input.context.current,
        snapshot = latest.current;
      if (
        !context.bridge ||
        focus.bridgeId !== context.bridge.bridgeId ||
        focus.contextId !== context.contextId ||
        focus.contextRevision !== context.revision
      )
        return false;
      if (focus.attention === 'work_dates') {
        const work = snapshot.collaboration?.works.find(
          (item) =>
            item.workId === focus.workId &&
            item.revision === focus.workRevision &&
            item.accountableHumanId === context.bridge?.humanId &&
            item.sourceLocation.channelId === focus.channelId,
        );
        if (!work) return false;
        const containing = snapshot.collaboration?.roadmaps.find((item) => item.workIds.includes(work.workId));
        if (containing)
          input.onFocus({
            roadmapId: containing.roadmapId,
            workId: work.workId,
            channelId: containing.sourceLocation.channelId,
            attention: 'work_dates',
          });
        else
          input.onFocus({ workId: work.workId, channelId: work.sourceLocation.channelId, eventId: work.sourceEventId });
        return true;
      }
      const project = snapshot.collaboration?.roadmaps.find(
        (item) =>
          item.roadmapId === focus.roadmapId &&
          item.status === 'active' &&
          item.sourceLocation.channelId === focus.channelId,
      );
      if (!project) return false;
      if (focus.attention === 'triage') {
        if (project.accountableHumanId !== context.bridge.humanId) return false;
      } else {
        const work = snapshot.collaboration?.works.find(
          (item) =>
            item.workId === focus.workId &&
            item.revision === focus.workRevision &&
            project.workIds.includes(item.workId) &&
            item.accountableHumanId === context.bridge?.humanId &&
            !['proposed', 'completed', 'cancelled', 'declined'].includes(item.lifecycle),
        );
        if (
          !work ||
          (focus.attention === 'date_suggestion' && !work.timeSuggestions?.some((item) => item.status === 'pending')) ||
          (focus.attention === 'overdue' &&
            (!work.time?.businessDeadline || Date.parse(work.time.businessDeadline.value) >= Date.now()))
        )
          return false;
      }
      input.onFocus({
        roadmapId: project.roadmapId,
        channelId: focus.channelId,
        attention: focus.attention,
        ...(focus.workId ? { workId: focus.workId } : {}),
      });
      return true;
    },
    [input.context, input.onFocus],
  );
  const handleFocus = useCallback(
    (unsafe: unknown) => {
      const parsed = collectiveHostProjectAttentionFocusSchema.safeParse(unsafe);
      if (!parsed.success) return false;
      pending.current = parsed.data;
      if (apply(parsed.data)) pending.current = undefined;
      return true;
    },
    [apply],
  );
  const reset = useCallback(() => {
    pending.current = undefined;
  }, []);
  useEffect(() => {
    if (pending.current && apply(pending.current)) pending.current = undefined;
  }, [apply, input.snapshot.collaboration]);
  return { handleFocus, reset };
}
