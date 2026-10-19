import { createHash } from 'node:crypto';
import {
  COLLECTIVE_ACCOUNTABILITY_ATTENTION_PRODUCER_ID,
  type CollectiveAccountabilityAttentionReadRequest,
  type CollectiveWorkAccountabilityRequest,
  type CollectiveWorkRecord,
  collectiveAccountabilityAttentionActionRef,
  collectiveAccountabilityAttentionItemSchema,
  collectiveAccountabilityAttentionSubjectRef,
} from '@cat-cafe/shared';
import { assertConnectionCoordinates, requireAuthorizedHuman, requireConnection } from './connection-authority.js';
import { CollectiveServiceError } from './errors.js';
import { requireMembership } from './identity-store.js';
import type { ServiceState } from './state.js';

export function readCollectiveAccountabilityAttention(
  state: ServiceState,
  endpointCredential: string,
  input: CollectiveAccountabilityAttentionReadRequest,
) {
  const connection = requireConnection(state, endpointCredential, input.connectionId);
  assertConnectionCoordinates(state, connection, input);
  const human = requireAuthorizedHuman(state, connection);
  const items = Object.values(state.works)
    .filter((work) => work.collectiveId === input.collectiveId)
    .flatMap((work) =>
      (work.accountabilityRequests ?? [])
        .filter((request) => request.status === 'pending' && request.targetHumanId === human.humanId)
        .flatMap((request) =>
          accountabilityRequestIsOperable(state, work, request, human.humanId)
            ? [projectAttentionItem(state, connection.connectionId, work, request)]
            : [],
        ),
    )
    .sort(
      (left, right) =>
        left.requestedAt.localeCompare(right.requestedAt) || left.subjectRef.localeCompare(right.subjectRef),
    );
  const snapshot = `sha256:${createHash('sha256').update(JSON.stringify(items)).digest('hex')}`;
  if (input.snapshot && input.snapshot !== snapshot) {
    throw new CollectiveServiceError(
      'ACCOUNTABILITY_ATTENTION_SNAPSHOT_CHANGED',
      'Pending responsibility requests changed between pages; restart the read',
      409,
    );
  }
  const selected = items.slice(input.offset, input.offset + input.limit);
  return {
    identity: {
      serviceInstanceId: state.serviceInstanceId,
      collectiveId: input.collectiveId,
      connectionId: connection.connectionId,
      authorizedHumanId: human.humanId,
    },
    items: selected,
    page: {
      offset: input.offset,
      limit: input.limit,
      hasMore: input.offset + input.limit < items.length,
      snapshot,
      totalCount: items.length,
    },
  };
}

export function requireOperableAccountabilityRequest(
  state: ServiceState,
  work: CollectiveWorkRecord,
  request: CollectiveWorkAccountabilityRequest,
  targetHumanId: string,
): void {
  if (!accountabilityRequestIsOperable(state, work, request, targetHumanId)) {
    throw new CollectiveServiceError(
      'ACCOUNTABILITY_REQUEST_UNAVAILABLE',
      'Task or Project responsibility changed before this request was answered',
      409,
    );
  }
}

function accountabilityRequestIsOperable(
  state: ServiceState,
  work: CollectiveWorkRecord,
  request: CollectiveWorkAccountabilityRequest,
  targetHumanId: string,
): boolean {
  if (
    request.status !== 'pending' ||
    request.targetHumanId !== targetHumanId ||
    work.lifecycle !== 'committed' ||
    work.assignment
  ) {
    return false;
  }
  try {
    requireMembership(state, work.collectiveId, targetHumanId);
  } catch {
    return false;
  }
  const roadmap = state.roadmaps[request.roadmapId];
  if (
    !roadmap ||
    roadmap.collectiveId !== work.collectiveId ||
    roadmap.status !== 'active' ||
    !roadmap.workIds.includes(work.workId)
  ) {
    return false;
  }
  const events = state.events[work.collectiveId] ?? [];
  const workSource = events.find((event) => event.eventId === work.sourceEventId);
  const projectSource = events.find((event) => event.eventId === roadmap.sourceEventId);
  const requestEvent = events.find((event) => event.eventId === request.requestEventId);
  return Boolean(
    workSource?.location?.channelId === work.sourceLocation.channelId &&
      projectSource?.location?.channelId === roadmap.sourceLocation.channelId &&
      requestEvent?.recipient?.kind === 'human' &&
      requestEvent.recipient.humanId === targetHumanId &&
      requestEvent.location?.channelId === work.sourceLocation.channelId &&
      requestEvent.replyToEventId === work.sourceEventId,
  );
}

function projectAttentionItem(
  state: ServiceState,
  connectionId: string,
  work: CollectiveWorkRecord,
  request: CollectiveWorkAccountabilityRequest,
) {
  const roadmap = state.roadmaps[request.roadmapId];
  if (!roadmap) throw new CollectiveServiceError('STATE_CORRUPT', 'Responsibility Project is missing', 409);
  const identity = {
    serviceInstanceId: state.serviceInstanceId,
    collectiveId: work.collectiveId,
    connectionId,
    workId: work.workId,
    accountabilityRequestId: request.accountabilityRequestId,
  };
  return collectiveAccountabilityAttentionItemSchema.parse({
    producerId: COLLECTIVE_ACCOUNTABILITY_ATTENTION_PRODUCER_ID,
    subjectRef: collectiveAccountabilityAttentionSubjectRef(identity),
    ...identity,
    workRevision: work.revision,
    expectedProducerRevision: work.revision,
    targetHumanId: request.targetHumanId,
    targetDisplayName: request.targetDisplayName,
    requestedByHumanId: request.requestedByHumanId,
    requestedByDisplayName: request.requestedByDisplayName,
    requestEventId: request.requestEventId,
    requestedAt: request.requestedAt,
    status: request.status,
    roadmapId: roadmap.roadmapId,
    projectTitle: roadmap.title,
    channelId: work.sourceLocation.channelId,
    workSourceEventId: work.sourceEventId,
    workTitle: work.title,
    actionRef: collectiveAccountabilityAttentionActionRef({
      ...identity,
      workRevision: work.revision,
      channelId: work.sourceLocation.channelId,
      roadmapId: roadmap.roadmapId,
    }),
  });
}
