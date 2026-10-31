import type { CollectiveMemberDirectory, CollectiveParticipant } from './client-types.js';
import type { RoadmapViewState } from './roadmap-view-model.js';

export interface RoadmapReturn {
  readonly channelId: string;
  readonly label: string;
  readonly view: RoadmapViewState;
}

export function ownDeclaredCatCount(
  participants: readonly CollectiveParticipant[] | undefined,
  connectionId: string | undefined,
) {
  if (!participants || !connectionId) return undefined;
  return new Set(
    participants
      .filter((cat) => cat.connectionId === connectionId && cat.availability === 'declared')
      .map((cat) => cat.catId),
  ).size;
}

export function visibleCollectiveCats(
  participants: readonly CollectiveParticipant[],
  members: CollectiveMemberDirectory | undefined,
) {
  return participants.filter(
    (cat) => cat.availability === 'declared' && members?.cafes.some((cafe) => cafe.connectionId === cat.connectionId),
  );
}
