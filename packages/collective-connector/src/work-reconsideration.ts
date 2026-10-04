import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { type CollectiveSourceIdentity, collectiveEventSourceIdentity } from '@cat-cafe/shared';
import type { CollectiveConnector } from './connector.js';
import { participationError, requireParticipation } from './participation-custody.js';
import type { ConnectorPersistence } from './persistence.js';
import type { ConnectorWorkPolicyCustody } from './work-policy-custody.js';

export interface WorkReconsiderationInput {
  readonly sourceEventId: string;
  readonly catId: string;
  readonly grantRef: string;
  readonly grantRevision: number;
  readonly requestKind: string;
}

/** Canonical source and current adopted permission, prepared only inside the connection authority fence. */
export async function prepareWorkReconsideration(input: {
  readonly persistence: ConnectorPersistence;
  readonly policy: ConnectorWorkPolicyCustody;
  readonly connectionId: string;
  readonly ownerUserId: string;
  readonly request: WorkReconsiderationInput;
  readonly readContext: CollectiveConnector['readParticipationContext'];
}) {
  const state = input.persistence.snapshot();
  const connection = state.connections[input.connectionId];
  const route = state.hostRoutes[input.connectionId];
  if (!connection || !route || route.localOwnerUserId !== input.ownerUserId)
    throw participationError('CONNECTOR_OWNER_MISMATCH', 'This owner has no current Host source relationship');
  const item = connection.inbox.find((candidate) => candidate.event.eventId === input.request.sourceEventId);
  const event = item?.event;
  const receipt = item?.routeReceipt;
  if (
    !event?.location ||
    item?.disposition !== 'routed' ||
    receipt?.kind !== 'thread_message' ||
    (receipt.catId && receipt.catId !== input.request.catId) ||
    event.workAcceptanceNotice ||
    event.workExecutionNotice ||
    event.workRevisionNotice
  )
    throw participationError('WORK_RECONSIDERATION_SOURCE_UNAVAILABLE', 'Reconsider the exact current public request');
  const source: CollectiveSourceIdentity = collectiveEventSourceIdentity(event) ?? {
    serviceInstanceId: event.serviceInstanceId,
    collectiveId: event.collectiveId,
    connectionId: input.connectionId,
    eventId: event.eventId,
    catId: input.request.catId,
    location: event.location,
    participationRevision: route.revision,
    actor: event.actor,
  };
  if (source.connectionId !== input.connectionId || source.catId !== input.request.catId)
    throw participationError('WORK_RECONSIDERATION_SOURCE_UNAVAILABLE', 'The request names another Café or Cat');
  const participation = requireParticipation(state, source);
  if (participation.binding.threadId !== receipt.threadId)
    throw participationError('WORK_RECONSIDERATION_SOURCE_UNAVAILABLE', 'The source endpoint changed');
  const context = await input.readContext(source, 0, 1);
  if (!isDeepStrictEqual(context.source.actor, event.actor) || context.source.body !== event.body)
    throw participationError('WORK_RECONSIDERATION_SOURCE_UNAVAILABLE', 'The canonical Service source changed');
  const grant = await input.policy.requireGrant(
    source,
    input.request.grantRef,
    input.request.grantRevision,
    input.request.requestKind,
  );
  requireParticipation(input.persistence.snapshot(), source);
  const purpose = [
    source.serviceInstanceId,
    source.collectiveId,
    source.connectionId,
    source.eventId,
    source.catId,
    source.participationRevision,
    grant.grantRef,
    grant.grantRevision,
    input.request.requestKind,
  ];
  return {
    source,
    event,
    sourceMessageId: receipt.messageId,
    threadId: receipt.threadId,
    ownerUserId: input.ownerUserId,
    grantRef: grant.grantRef,
    grantRevision: grant.grantRevision,
    requestKind: input.request.requestKind,
    purposeKey: `collective-reconsider:${createHash('sha256').update(JSON.stringify(purpose)).digest('hex')}`,
    /** The Host awaits its own source/thread reads before it can publish; refresh permission after those reads. */
    assertCurrentPermission: async () => {
      await input.policy.requireGrant(source, grant.grantRef, grant.grantRevision, input.request.requestKind);
      requireParticipation(input.persistence.snapshot(), source);
    },
  };
}
export type WorkReconsiderationAuthorityScope = Awaited<ReturnType<typeof prepareWorkReconsideration>>;
