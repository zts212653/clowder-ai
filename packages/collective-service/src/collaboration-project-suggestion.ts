import type {
  CollectiveAgentWorkProposalRequest,
  DecideCollectiveProjectWorkSuggestionRequest,
} from '@cat-cafe/shared';
import { advanceWork, humanActor, mutableWork, requireRoadmap } from './collaboration-command-helpers.js';
import { commitCollectiveWorkUnassigned } from './collaboration-commit.js';
import { collaborationOperationReplay, recordCollaborationOperation } from './collaboration-operations.js';
import {
  assertDependencySet,
  projectCollectiveWork,
  requireCollectiveWork,
  requireWorkAccountableHuman,
  requireWorkRevision,
} from './collaboration-work.js';
import { CollectiveServiceError } from './errors.js';
import { requireLinkedParticipationSource } from './participation-store.js';
import type { MutableServiceState } from './state.js';

type Human = { readonly humanId: string; readonly displayName: string; readonly avatarUrl?: string };

export function assertAgentProjectSuggestion(
  state: MutableServiceState,
  credential: string,
  input: CollectiveAgentWorkProposalRequest,
) {
  const suggestion = input.projectSuggestion;
  if (!suggestion) return;
  const roadmap = requireRoadmap(state, input.collectiveId, suggestion.roadmapId);
  if (roadmap.status !== 'active') {
    throw new CollectiveServiceError('ROADMAP_COMPLETED', 'A completed Project cannot receive suggestions', 409);
  }
  if (roadmap.revision !== suggestion.roadmapRevision) {
    throw new CollectiveServiceError(
      'ROADMAP_REVISION_CONFLICT',
      'Collective Project changed; refresh and try again',
      409,
    );
  }
  requireLinkedParticipationSource(state, credential, input, roadmap.sourceEventId);
  if (!suggestion.prerequisiteForWorkId) return;
  const prerequisiteRevision = suggestion.prerequisiteForWorkRevision;
  if (prerequisiteRevision === undefined) {
    throw new CollectiveServiceError('STATE_CORRUPT', 'Project prerequisite suggestion revision is missing', 409);
  }
  const target = requireCollectiveWork(state, input.collectiveId, suggestion.prerequisiteForWorkId);
  requireWorkRevision(target, prerequisiteRevision);
  if (!roadmap.workIds.includes(target.workId)) {
    throw new CollectiveServiceError('WORK_NOT_IN_ROADMAP', 'Prerequisite target is not in the selected Project', 409);
  }
  if (['completed', 'declined', 'cancelled'].includes(target.lifecycle)) {
    throw new CollectiveServiceError('WORK_TERMINAL', 'Closed Work cannot receive a prerequisite suggestion', 409);
  }
  requireLinkedParticipationSource(state, credential, input, target.sourceEventId);
}

export function decideProjectWorkSuggestion(
  state: MutableServiceState,
  input: DecideCollectiveProjectWorkSuggestionRequest,
  human: Human,
  now: number,
) {
  const actorScope = `human:${human.humanId}`;
  const replay = collaborationOperationReplay(state, {
    ...input,
    actorScope,
    payload: input,
    resourceKind: 'work',
  });
  if (replay.existing) {
    const replayed = requireCollectiveWork(state, input.collectiveId, replay.existing.resourceId);
    return suggestionDecisionProjection(state, replayed, now);
  }
  const work = mutableWork(state, input.collectiveId, input.workId);
  requireWorkRevision(work, input.expectedRevision);
  const suggestion = work.projectSuggestion;
  if (!suggestion || work.lifecycle !== 'proposed' || work.proposedBy.kind !== 'agent') {
    throw new CollectiveServiceError('WORK_NOT_PROPOSED', 'Only a pending Cat Project suggestion can be decided', 409);
  }
  const roadmap = requireRoadmap(state, input.collectiveId, suggestion.roadmapId);
  if (roadmap.accountableHumanId !== human.humanId) {
    throw new CollectiveServiceError(
      'ROADMAP_AUTHORITY_REQUIRED',
      'Only the Project owner can decide this suggestion',
      403,
    );
  }
  if (roadmap.revision !== input.expectedRoadmapRevision) {
    throw new CollectiveServiceError(
      'ROADMAP_REVISION_CONFLICT',
      'Collective Project changed; refresh and try again',
      409,
    );
  }
  const at = new Date(now).toISOString();
  if (input.decision === 'ignore') {
    work.lifecycle = 'declined';
    advanceWork(work, 'declined', humanActor(human), at, work.sourceEventId, input.reason ?? '未采用项目建议');
    recordCollaborationOperation(state, {
      ...replay,
      actorScope,
      resourceKind: 'work',
      resourceId: work.workId,
      revision: work.revision,
      recordedAt: at,
    });
    return suggestionDecisionProjection(state, work, now);
  }
  if (roadmap.status !== 'active') {
    throw new CollectiveServiceError('ROADMAP_COMPLETED', 'Reopen this Project before accepting suggestions', 409);
  }
  const target = requireSuggestionTarget(state, input, suggestion, roadmap, human.humanId);
  if (input.title) work.title = input.title;
  if (input.intendedOutcome) work.intendedOutcome = input.intendedOutcome;
  commitCollectiveWorkUnassigned(work, human, now);
  if (target) {
    const nextDependencies = [...target.dependencyWorkIds, work.workId];
    assertDependencySet(state, target, nextDependencies);
    target.dependencyWorkIds = nextDependencies;
    advanceWork(
      target,
      'dependencies_changed',
      humanActor(human),
      at,
      work.sourceEventId,
      `采用猫建议，新增前置任务：${work.title}`,
    );
  }
  roadmap.workIds = [...roadmap.workIds, work.workId];
  roadmap.revision += 1;
  roadmap.updatedAt = at;
  roadmap.history.push({
    revision: roadmap.revision,
    action: 'works_changed',
    actor: humanActor(human),
    at,
    note: target ? `采用前置任务建议：${work.title}` : `采用任务建议：${work.title}`,
  });
  recordCollaborationOperation(state, {
    ...replay,
    actorScope,
    resourceKind: 'work',
    resourceId: work.workId,
    revision: work.revision,
    recordedAt: at,
  });
  return suggestionDecisionProjection(state, work, now);
}

function requireSuggestionTarget(
  state: MutableServiceState,
  input: DecideCollectiveProjectWorkSuggestionRequest,
  suggestion: NonNullable<MutableServiceState['works'][string]['projectSuggestion']>,
  roadmap: MutableServiceState['roadmaps'][string],
  humanId: string,
) {
  if (!suggestion.prerequisiteForWorkId) return undefined;
  const target = mutableWork(state, input.collectiveId, suggestion.prerequisiteForWorkId);
  if (!input.expectedTargetWorkRevision) {
    throw new CollectiveServiceError('WORK_REVISION_CONFLICT', 'Current prerequisite target revision is required', 409);
  }
  requireWorkRevision(target, input.expectedTargetWorkRevision);
  requireWorkAccountableHuman(target, humanId);
  if (!roadmap.workIds.includes(target.workId)) {
    throw new CollectiveServiceError('WORK_NOT_IN_ROADMAP', 'Prerequisite target is not in the selected Project', 409);
  }
  if (['completed', 'declined', 'cancelled'].includes(target.lifecycle)) {
    throw new CollectiveServiceError('WORK_TERMINAL', 'Closed Work cannot receive new dependencies', 409);
  }
  return target;
}

function suggestionDecisionProjection(
  state: MutableServiceState,
  work: MutableServiceState['works'][string],
  now: number,
) {
  const suggestion = work.projectSuggestion;
  if (!suggestion) throw new CollectiveServiceError('STATE_CORRUPT', 'Project suggestion provenance is missing', 409);
  const roadmap = requireRoadmap(state, work.collectiveId, suggestion.roadmapId);
  const targetWork = suggestion.prerequisiteForWorkId
    ? requireCollectiveWork(state, work.collectiveId, suggestion.prerequisiteForWorkId)
    : undefined;
  return {
    work: projectCollectiveWork(state, work, now),
    roadmap: structuredClone(roadmap),
    ...(targetWork ? { targetWork: projectCollectiveWork(state, targetWork, now) } : {}),
  };
}
