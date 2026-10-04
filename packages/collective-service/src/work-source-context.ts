import {
  type CollectiveWorkRecord,
  type CollectiveWorkRoutingReadRequest,
  type CollectiveWorkSourceReadRequest,
  collectiveWorkSourceContextSchema,
} from '@cat-cafe/shared';
import { workReferences } from './collaboration-agent-continuation.js';
import { requireWorkSource } from './collaboration-command-helpers.js';
import { projectCollectiveWork } from './collaboration-work.js';
import { assertConnectionCoordinates, requireAuthorizedHuman, requireConnection } from './connection-authority.js';
import { requireParticipationSource } from './participation-store.js';
import type { ServiceState } from './state.js';

/** Discovery is confined to the source's current public channel and this exact assigned Café/Cat. */
export function readWorkSourceContext(
  state: ServiceState,
  credential: string,
  input: CollectiveWorkSourceReadRequest,
  now = Date.now(),
) {
  const source = requireParticipationSource(state, credential, { ...input, eventId: input.sourceEventId });
  const candidates = Object.values(state.works).filter(
    (work) =>
      work.collectiveId === input.collectiveId &&
      work.sourceLocation.channelId === source.location.channelId &&
      ((work.assignment?.connectionId === input.connectionId && work.assignment.catId === input.catId) ||
        (work.lifecycle === 'proposed' &&
          work.proposedBy.kind === 'agent' &&
          work.proposedBy.connectionId === input.connectionId &&
          work.proposedBy.catId === input.catId)),
  );
  const related = candidates.filter((work) =>
    [source.eventId, source.replyToEventId].some((id) => id && workReferences(work, id)),
  );
  const relatedIds = new Set(related.map((work) => work.workId));
  const ordered = candidates.sort(
    (a, b) =>
      Number(relatedIds.has(b.workId)) - Number(relatedIds.has(a.workId)) || b.updatedAt.localeCompare(a.updatedAt),
  );
  const matters = ordered.slice(0, 30).map((work) => ({
    ...projectPublicMatter(state, work, now),
    ...(work.lifecycle === 'proposed' && work.sourceEventId === source.eventId
      ? { proposedOutcome: work.intendedOutcome }
      : {}),
  }));
  return collectiveWorkSourceContextSchema.parse({
    sourceEventId: source.eventId,
    matters,
    relatedWorkIds: matters.filter((matter) => relatedIds.has(matter.workId)).map((matter) => matter.workId),
    hasMore: ordered.length > matters.length,
  });
}

/** Machine routing discovers only precise related assignments, before selecting a Cat to wake. */
export function readWorkRoutingContext(
  state: ServiceState,
  credential: string,
  input: CollectiveWorkRoutingReadRequest,
  now = Date.now(),
) {
  const connection = requireConnection(state, credential, input.connectionId);
  assertConnectionCoordinates(state, connection, input);
  const owner = requireAuthorizedHuman(state, connection);
  const source = requireWorkSource(state, input.collectiveId, input.sourceEventId);
  const declaration = state.participations[input.connectionId];
  const matches = Object.values(state.works).filter(
    (work) =>
      work.collectiveId === input.collectiveId &&
      work.sourceLocation.channelId === source.location.channelId &&
      work.assignment?.connectionId === connection.connectionId &&
      work.assignment.humanId === owner.humanId &&
      [source.eventId, source.replyToEventId].some((id) => id && workReferences(work, id)),
  );
  const visible = matches.filter((work) => {
    if (
      !declaration ||
      !work.assignment ||
      !declaration.agents.some(
        (agent) => agent.catId === work.assignment?.catId && agent.channelIds.includes(source.location.channelId),
      )
    )
      return false;
    requireParticipationSource(state, credential, {
      ...input,
      eventId: source.eventId,
      catId: work.assignment.catId,
      participationRevision:
        source.recipient?.kind === 'agent' ? source.recipient.participationRevision : declaration.revision,
    });
    return true;
  });
  const matters = visible.slice(0, 30).map((work) => projectPublicMatter(state, work, now));
  return collectiveWorkSourceContextSchema.parse({
    sourceEventId: source.eventId,
    matters,
    relatedWorkIds: matters.map((work) => work.workId),
    hasMore: visible.length > matters.length,
  });
}

function projectPublicMatter(state: ServiceState, work: CollectiveWorkRecord, now: number) {
  const projection = projectCollectiveWork(state, work, now);
  return {
    workId: work.workId,
    sourceEventId: work.sourceEventId,
    sourceLocation: work.sourceLocation,
    title: work.title,
    intendedOutcomePreview: work.intendedOutcome.slice(0, 500),
    accountableHumanId: work.accountableHumanId,
    assignment: work.assignment,
    assignmentEventId: work.assignmentEventId,
    lifecycle: work.lifecycle,
    status: projection.status,
    executionStatus: projection.executionStatus,
    resultEventId: work.resultEventId,
    resultRevision: work.resultRevision,
    revision: work.revision,
    executionRevision: work.executionAuthority?.revision,
    requestKind: work.executionAuthority?.requestKind ?? work.acceptance?.requestKind ?? work.proposedRequestKind,
  };
}
