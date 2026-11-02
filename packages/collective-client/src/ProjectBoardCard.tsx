import type {
  CollectiveMemberDirectory,
  CollectiveParticipant,
  CollectiveRoadmapRecord,
  CollectiveWorkProjection,
} from './client-types.js';
import { WorkIdentityChips } from './ProjectIdentityChip.js';
import { ProjectResponsibilityInline } from './ProjectResponsibilityInline.js';
import { workAccountabilityRequestState } from './roadmap-view-model.js';
import { WorkTimeSummary } from './WorkTimeSummary.js';
import { workBlockingPresentation } from './work-blocking-presentation.js';

export function ProjectBoardCard({
  work,
  availableWorks,
  projectWorks,
  projects,
  allRoadmaps = projects,
  currentHumanId,
  humans,
  participants,
  humanNames,
  onSelect,
  onCommitWork,
  onRequestWorkAccountability,
  onRespondWorkAccountability,
}: {
  readonly work: CollectiveWorkProjection;
  readonly availableWorks: readonly CollectiveWorkProjection[];
  readonly projectWorks: readonly CollectiveWorkProjection[];
  readonly projects: readonly CollectiveRoadmapRecord[];
  readonly allRoadmaps?: readonly CollectiveRoadmapRecord[];
  readonly currentHumanId: string;
  readonly humans: CollectiveMemberDirectory['humans'];
  readonly participants: readonly CollectiveParticipant[];
  readonly humanNames: Readonly<Record<string, string>>;
  readonly onSelect: (work: CollectiveWorkProjection) => void;
  readonly onCommitWork?: (
    work: CollectiveWorkProjection,
    participant?: CollectiveParticipant,
    accountability?: 'self' | 'unassigned',
  ) => Promise<void>;
  readonly onRequestWorkAccountability?: (
    roadmap: CollectiveRoadmapRecord,
    work: CollectiveWorkProjection,
    targetHumanId: string,
  ) => Promise<void>;
  readonly onRespondWorkAccountability?: (
    work: CollectiveWorkProjection,
    request: NonNullable<CollectiveWorkProjection['accountabilityRequests']>[number],
    decision: 'accept' | 'decline',
    participant?: CollectiveParticipant,
  ) => Promise<void>;
}) {
  const blockedBanner = projectBoardBlockedLabel(work, availableWorks);
  const requestState = workAccountabilityRequestState(work, allRoadmaps);
  const downstream = projectWorks.filter((candidate) => {
    const blocking = workBlockingPresentation(candidate, availableWorks);
    return blocking?.kind === 'dependencies' && blocking.incompleteWorkIds.includes(work.workId);
  });
  const targetedRequest =
    requestState.roadmap && requestState.pending?.targetHumanId === currentHumanId ? requestState.pending : undefined;
  const actionRoadmap = targetedRequest
    ? (projects.find((roadmap) => roadmap.status === 'active') ?? requestState.roadmap)
    : requestState.pending
      ? undefined
      : projects.find((roadmap) => roadmap.status === 'active' && roadmap.accountableHumanId === currentHumanId);
  const accountable = work.accountableHumanId ? (humanNames[work.accountableHumanId] ?? '共同体成员') : undefined;
  return (
    <article className="project-board-card" data-roadmap-work-id={work.workId} data-work-status={work.status}>
      {blockedBanner && <span className="project-board-banner project-board-banner-critical">{blockedBanner}</span>}
      {work.lifecycle === 'result_ready' && (
        <span className="project-board-banner project-board-banner-warning">等 {accountable ?? '负责人'} 验收</span>
      )}
      <button type="button" className="project-board-card-open" onClick={() => onSelect(work)}>
        <strong>{work.title}</strong>
        {projects.length > 0 && <span>{projects.map((project) => project.title).join(' · ')}</span>}
      </button>
      <WorkIdentityChips work={work} humans={humans} participants={participants} humanNames={humanNames} />
      <WorkTimeSummary work={work} board />
      {downstream.length > 0 && (
        <p className="project-board-downstream">正挡住 {downstream.map((item) => item.title).join('、')}</p>
      )}
      {actionRoadmap && (
        <ProjectResponsibilityInline
          roadmap={actionRoadmap}
          roadmaps={allRoadmaps}
          work={work}
          currentHumanId={currentHumanId}
          humans={humans}
          onCommit={onCommitWork}
          onRequest={onRequestWorkAccountability}
          onRespond={onRespondWorkAccountability}
        />
      )}
    </article>
  );
}

function projectBoardBlockedLabel(
  work: CollectiveWorkProjection,
  availableWorks: readonly CollectiveWorkProjection[],
): string | undefined {
  return workBlockingPresentation(work, availableWorks)?.label;
}
