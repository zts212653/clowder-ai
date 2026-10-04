import type {
  CollectiveCollaborationProjection,
  CollectiveRoadmapRecord,
  CollectiveWorkProjection,
} from './client-types.js';

export interface RoadmapAction {
  readonly label: string;
  readonly onInvoke: (work: CollectiveWorkProjection) => void;
}

export function roadmapActionsFor(
  work: CollectiveWorkProjection,
  roadmaps: readonly CollectiveRoadmapRecord[],
  currentHumanId: string,
  createRoadmap: (work: CollectiveWorkProjection) => Promise<void>,
  setRoadmapWorks: (roadmap: CollectiveRoadmapRecord, workIds: readonly string[]) => Promise<void>,
): readonly RoadmapAction[] {
  const ownedActive = roadmaps.filter(
    (roadmap) => roadmap.accountableHumanId === currentHumanId && roadmap.status === 'active',
  );
  const available = ownedActive.filter((roadmap) => !roadmap.workIds.includes(work.workId));
  if (available.length) {
    return available.map((roadmap) => ({
      label: `加入「${roadmap.title}」`,
      onInvoke: () => void setRoadmapWorks(roadmap, [...roadmap.workIds, work.workId]).catch(() => undefined),
    }));
  }
  if (ownedActive.length) return [];
  return [
    {
      label: roadmaps.length ? '建立另一条路线' : '建立路线',
      onInvoke: () => void createRoadmap(work).catch(() => undefined),
    },
  ];
}

export function collaborationForChannel(
  collaboration: CollectiveCollaborationProjection | undefined,
  channelId: string,
) {
  if (!collaboration) {
    return { allWorks: [], channelWorks: [], channelVotes: [], roadmaps: [], bindingVotes: [], decisions: [] };
  }
  return {
    allWorks: collaboration.works,
    channelWorks: collaboration.works.filter((work) => work.sourceLocation.channelId === channelId),
    channelVotes: collaboration.votes.filter((vote) => vote.sourceLocation.channelId === channelId),
    roadmaps: collaboration.roadmaps.filter((roadmap) => roadmap.sourceLocation.channelId === channelId),
    bindingVotes: collaboration.bindingVotes.filter((vote) => vote.sourceLocation.channelId === channelId),
    decisions: collaboration.decisions.filter((decision) => decision.sourceLocation.channelId === channelId),
  };
}
