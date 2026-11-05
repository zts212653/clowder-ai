import { eventChannelId } from './channel-navigation.js';
import type {
  CollectiveCollaborationProjection,
  CollectiveEventEnvelope,
  CollectiveWorkProjection,
} from './client-types.js';

export interface CollectiveHomeActivity {
  readonly id: string;
  readonly actorName: string;
  readonly actionLabel: string;
  readonly title: string;
  readonly channelId: string;
  readonly eventId: string;
  readonly at: string;
}

export interface CollectiveHomeProjection {
  readonly activities: readonly CollectiveHomeActivity[];
  readonly partial: boolean;
}

const activityLabels: Readonly<Partial<Record<CollectiveWorkProjection['history'][number]['action'], string>>> = {
  proposed: '提出了',
  committed: '接受了',
  accountability_assigned: '接下了',
  dependencies_changed: '更新了前置任务',
  progress_started: '开始推进',
  progress_reported: '更新了进展',
  result_returned: '带回了',
  revision_requested: '请求修改',
  result_accepted: '确认了',
  completed: '完成了',
  declined: '拒绝了',
  cancelled: '取消了',
};

export function projectCollectiveHome(
  events: readonly CollectiveEventEnvelope[],
  collaboration: CollectiveCollaborationProjection | undefined,
): CollectiveHomeProjection {
  if (!collaboration) return { activities: [], partial: false };
  const eventsById = new Map(events.map((event) => [event.eventId, event]));
  const activities = collaboration.works
    .flatMap((work) =>
      work.history.flatMap((entry) => {
        const actionLabel = activityLabels[entry.action];
        if (!actionLabel) return [];
        const event = visibleHistoryEvent(work, entry.eventId, eventsById);
        const channelId = event ? eventChannelId(event) : undefined;
        return event && channelId
          ? [
              {
                id: `${work.workId}:${entry.revision}`,
                actorName: entry.actor.displayName,
                actionLabel,
                title: work.title,
                channelId,
                eventId: event.eventId,
                at: entry.at,
              },
            ]
          : [];
      }),
    )
    .sort((left, right) => right.at.localeCompare(left.at))
    .slice(0, 4);
  const partial = collaboration.works.some(
    (work) => Boolean(work.resultEventId) && !eventsById.has(work.resultEventId as string),
  );
  return { activities, partial };
}

function visibleHistoryEvent(
  work: CollectiveWorkProjection,
  entryEventId: string | undefined,
  events: ReadonlyMap<string, CollectiveEventEnvelope>,
): CollectiveEventEnvelope | undefined {
  if (entryEventId && events.has(entryEventId)) return events.get(entryEventId);
  if (work.resultEventId && events.has(work.resultEventId)) return events.get(work.resultEventId);
  return events.get(work.sourceEventId);
}
