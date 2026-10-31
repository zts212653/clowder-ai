import { describeMessageInvocationTrajectory } from '@/components/InvocationTrajectoryAnchor';
import type { ChatMessage } from '@/stores/chat-types';
import { getMessageTimelineOrderTime } from '@/stores/message-timeline';

export interface StatusLastRun {
  invocationId: string;
  /** Time of the run's last observed message, not an invented completion timestamp. */
  observedAt: number;
}

/** Project the same durable identities used by chat's trajectory buttons, within one owning thread. */
export function projectStatusLastRuns(messages: readonly ChatMessage[]): ReadonlyMap<string, StatusLastRun> {
  const runs = new Map<string, StatusLastRun>();
  for (const message of messages) {
    if (
      message.type !== 'assistant' ||
      !message.catId ||
      message.isStreaming ||
      message.id.startsWith('draft-') ||
      message.extra?.crossPost ||
      message.extra?.isExplicitPost
    )
      continue;
    const trajectory = describeMessageInvocationTrajectory(message);
    if (!trajectory || trajectory.status === 'running') continue;
    const observedAt = getMessageTimelineOrderTime(message);
    if (!Number.isFinite(observedAt) || observedAt < (runs.get(message.catId)?.observedAt ?? -Infinity)) continue;
    runs.set(message.catId, {
      invocationId: trajectory.invocationId,
      observedAt,
    });
  }
  return runs;
}
