import { isDeepStrictEqual } from 'node:util';
import type {
  CollectiveAgentMessageRequest,
  CollectiveCollaborationActor,
  CollectiveEventEnvelope,
  CollectiveWorkProjection,
  CollectiveWorkRecord,
  CollectiveWorkResultReceipt,
} from '@cat-cafe/shared';
import { CollectiveServiceError } from './errors.js';
import type { MutableServiceState, ServiceState } from './state.js';
import { requireAcceptedWorkExecution } from './work-execution-authority.js';
import { projectWorkExecutionStatus } from './work-execution-status.js';

export function requireCollectiveWork(state: ServiceState, collectiveId: string, workId: string): CollectiveWorkRecord {
  const work = state.works[workId];
  if (!work || work.collectiveId !== collectiveId) {
    throw new CollectiveServiceError('WORK_NOT_FOUND', 'Collective Work was not found', 404);
  }
  return work;
}

export function requireWorkRevision(work: CollectiveWorkRecord, expectedRevision: number): void {
  if (work.revision !== expectedRevision) {
    throw new CollectiveServiceError('WORK_REVISION_CONFLICT', 'Collective Work changed; refresh and try again', 409);
  }
}

export function requireWorkAccountableHuman(work: CollectiveWorkRecord, humanId: string): void {
  if (work.accountableHumanId !== humanId) {
    throw new CollectiveServiceError('WORK_AUTHORITY_REQUIRED', 'Only the accountable Human can change this Work', 403);
  }
}

export function projectCollectiveWork(
  state: ServiceState,
  work: CollectiveWorkRecord,
  now = Date.now(),
): CollectiveWorkProjection {
  const executionStatus = projectWorkExecutionStatus(state, work, now);
  const status = workStatus(state, work, executionStatus);
  return structuredClone({ ...work, status, ...(executionStatus ? { executionStatus } : {}) });
}

export function assertDependencySet(
  state: ServiceState,
  work: CollectiveWorkRecord,
  dependencyWorkIds: readonly string[],
): void {
  if (new Set(dependencyWorkIds).size !== dependencyWorkIds.length || dependencyWorkIds.includes(work.workId)) {
    throw new CollectiveServiceError(
      'WORK_DEPENDENCY_INVALID',
      'Work dependencies must be unique and cannot self-link',
      422,
    );
  }
  for (const dependencyId of dependencyWorkIds) requireCollectiveWork(state, work.collectiveId, dependencyId);
  const overrides = new Map([[work.workId, [...dependencyWorkIds]]]);
  if (canReachWork(state, work.collectiveId, work.workId, work.workId, overrides, new Set(), true)) {
    throw new CollectiveServiceError('WORK_DEPENDENCY_CYCLE', 'Work dependencies cannot form a cycle', 409);
  }
}

export function recordCollectiveWorkResult(
  state: MutableServiceState,
  event: CollectiveEventEnvelope,
  now: number,
): void {
  const receipt = event.workResultReceipt;
  if (event.actor.kind !== 'agent' || !event.replyToEventId || !receipt) return;
  const work = Object.values(state.works).find(
    (candidate) =>
      candidate.collectiveId === event.collectiveId && candidate.assignmentEventId === receipt.assignmentEventId,
  );
  if (!work?.assignment || !event.location || event.location.channelId !== work.sourceLocation.channelId) return;
  const assignmentCatId = receipt.assignmentCatId ?? receipt.catId;
  if (
    event.replyToEventId !== receipt.assignmentEventId ||
    work.assignment.connectionId !== event.actor.provenance.connectionId ||
    work.assignment.connectionId !== receipt.connectionId ||
    work.assignment.catId !== assignmentCatId ||
    receipt.catId !== event.actor.provenance.catId ||
    work.assignment.humanId !== event.actor.human.humanId ||
    work.assignment.humanId !== receipt.humanId ||
    (work.executionAuthority?.participationRevision ?? work.assignment.participationRevision) !==
      receipt.participationRevision ||
    (work.executionAuthority?.revision ?? 1) !== (receipt.executionRevision ?? 1)
  ) {
    return;
  }
  if (work.resultEventId === event.eventId) return;
  if (!['committed', 'in_progress'].includes(work.lifecycle)) return;
  const currentResultRevision = work.resultEventId ? (work.resultRevision ?? 1) : 0;
  if (receipt.resultRevision !== currentResultRevision + 1) return;
  const revision = work.revision + 1;
  const at = new Date(now).toISOString();
  work.lifecycle = 'result_ready';
  work.resultEventId = event.eventId;
  work.resultRevision = receipt.resultRevision;
  work.revision = revision;
  work.updatedAt = at;
  work.history.push({
    revision,
    action: 'result_returned',
    actor: collaborationActorFromEvent(event),
    at,
    eventId: event.eventId,
    resultRevision: receipt.resultRevision,
  });
}

export function issueCollectiveWorkResultReceipt(
  state: ServiceState,
  input: CollectiveAgentMessageRequest,
  actor: { readonly connectionId: string; readonly humanId: string; readonly catId: string },
  now: number,
): CollectiveWorkResultReceipt | undefined {
  const intent = input.workResultIntent;
  if (!intent) return undefined;
  const work = Object.values(state.works).find(
    (candidate) =>
      candidate.collectiveId === input.collectiveId && candidate.assignmentEventId === intent.assignmentEventId,
  );
  const assignmentCatId = intent.assignmentCatId ?? actor.catId;
  if (
    input.replyToEventId !== intent.assignmentEventId ||
    input.participationRevision !== intent.participationRevision ||
    !work?.assignment ||
    work.assignment.connectionId !== actor.connectionId ||
    work.assignment.humanId !== actor.humanId ||
    work.assignment.catId !== assignmentCatId ||
    (work.executionAuthority?.participationRevision ?? work.assignment.participationRevision) !==
      intent.participationRevision
  ) {
    throw new CollectiveServiceError(
      'RETURN_UNAVAILABLE',
      'Work result is not bound to the current exact assignment',
      409,
    );
  }
  if ((work.executionAuthority?.revision ?? 1) !== (intent.executionRevision ?? 1))
    throw new CollectiveServiceError(
      'WORK_EXECUTION_NOT_CURRENT',
      'This result belongs to an older execution authority',
      409,
    );
  requireAcceptedWorkExecution(state, work, now);
  const replayEventId =
    state.clientEventIndex[`${input.collectiveId}:connection:${actor.connectionId}:${input.clientEventId}`];
  const replay = replayEventId
    ? (state.events[input.collectiveId] ?? []).find((event) => event.eventId === replayEventId)
    : undefined;
  if (replay?.workResultReceipt) {
    const { workId: _workId, connectionId, humanId, catId, ...replayedIntent } = replay.workResultReceipt;
    if (
      connectionId === actor.connectionId &&
      humanId === actor.humanId &&
      catId === actor.catId &&
      isDeepStrictEqual(replayedIntent, { ...intent, assignmentCatId })
    ) {
      return replay.workResultReceipt;
    }
    throw new CollectiveServiceError('CLIENT_EVENT_CONFLICT', 'clientEventId already names another Work result', 409);
  }
  const currentResultRevision = work.resultEventId ? (work.resultRevision ?? 1) : 0;
  if (!['committed', 'in_progress'].includes(work.lifecycle) || intent.resultRevision !== currentResultRevision + 1) {
    throw new CollectiveServiceError(
      'WORK_RESULT_REVISION_CONFLICT',
      'Work result does not match the current requested revision',
      409,
    );
  }
  return {
    ...intent,
    assignmentCatId,
    workId: work.workId,
    connectionId: actor.connectionId,
    humanId: actor.humanId,
    catId: actor.catId,
  };
}

export function collaborationActorFromEvent(event: CollectiveEventEnvelope): CollectiveCollaborationActor {
  if (event.actor.kind === 'human') {
    return { kind: 'human', humanId: event.actor.humanId, displayName: event.actor.displayName };
  }
  return {
    kind: 'agent',
    humanId: event.actor.human.humanId,
    humanDisplayName: event.actor.human.displayName,
    connectionId: event.actor.provenance.connectionId,
    catId: event.actor.provenance.catId,
    displayName: event.actor.agent.displayName,
  };
}

function workStatus(
  state: ServiceState,
  work: CollectiveWorkRecord,
  executionStatus: CollectiveWorkProjection['executionStatus'],
): CollectiveWorkProjection['status'] {
  if (work.lifecycle !== 'committed' && work.lifecycle !== 'in_progress') return work.lifecycle;
  if (executionStatus && executionStatus.state !== 'permitted') return 'blocked';
  const blocked = work.dependencyWorkIds.some((dependencyId) => state.works[dependencyId]?.lifecycle !== 'completed');
  if (blocked) return 'blocked';
  return work.lifecycle === 'committed' ? 'ready' : 'in_progress';
}

function canReachWork(
  state: ServiceState,
  collectiveId: string,
  currentId: string,
  targetId: string,
  overrides: ReadonlyMap<string, readonly string[]>,
  visited: Set<string>,
  skipInitialMatch: boolean,
): boolean {
  if (!skipInitialMatch && currentId === targetId) return true;
  if (visited.has(currentId)) return false;
  visited.add(currentId);
  const current = state.works[currentId];
  if (!current || current.collectiveId !== collectiveId) return false;
  const dependencies = overrides.get(currentId) ?? current.dependencyWorkIds;
  return dependencies.some((dependencyId) =>
    canReachWork(state, collectiveId, dependencyId, targetId, overrides, visited, false),
  );
}
