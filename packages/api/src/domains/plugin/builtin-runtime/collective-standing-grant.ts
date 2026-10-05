import type { CollectiveConnector } from '@cat-cafe/collective-connector';
import {
  type CollectiveWorkProjection,
  collectiveSourceIdentitySchema,
  collectiveWorkAssignmentMatches,
  participationSourceIsCurrent,
  type RegisteredCustodyGrantV1,
} from '@cat-cafe/shared';
import type { StoredMessage } from '../../cats/services/stores/ports/MessageStore.js';

/** Derives a current grant from the existing Host binding. No second permission store. */
export async function resolveCollectiveStandingGrant(
  connector: CollectiveConnector | undefined,
  sourceMessage: StoredMessage,
  catId: string,
) {
  const parsed = collectiveSourceIdentitySchema.safeParse(sourceMessage.source?.meta?.participation);
  if (!connector || !parsed.success || parsed.data.catId !== catId) return undefined;
  if (parsed.data.actor.kind === 'agent') {
    const route = await connector.getHostRoute(parsed.data.connectionId);
    if (route?.localOwnerUserId !== sourceMessage.userId) return undefined;
    const current = await connector.resolveAcceptedWorkGrant(parsed.data);
    return {
      acceptedWork: current.work,
      grant: {
        grantRef: `collective-owner:${parsed.data.connectionId}:${current.grant.grantRef}`,
        revision: current.grant.grantRevision,
        producerRef: 'host:collective-registered-work',
        grantOwnerRef: `user:${route.localOwnerUserId}`,
        grantOwnerRevision: current.grant.grantRevision,
        allowedSourceScope: [`message:${sourceMessage.id}`],
        admissionAuthority: 'task_admit_or_resume' as const,
        validity: { state: 'current' as const, expiresAt: current.grant.expiresAt },
        idempotencySource: 'source_ref_and_revision' as const,
      },
    };
  }
  const source = parsed.data;
  await connector.readParticipationContext(source, 0, 1);
  const route = await connector.getHostRoute(source.connectionId);
  const connection = await connector.getProjection(source.connectionId);
  const scope = route?.agentRoutes[`${connection.authorizedHumanId}:${catId}`]?.standingWork;
  const scopeRevision =
    route?.agentRoutes[`${connection.authorizedHumanId}:${catId}`]?.standingWorkRevision ?? route?.revision;
  if (
    !route ||
    route.localOwnerUserId !== sourceMessage.userId ||
    !participationSourceIsCurrent(route, catId, source.location.channelId, source.participationRevision) ||
    !scopeRevision ||
    !scope ||
    !scope.requestingHumanIds.includes(parsed.data.actor.humanId) ||
    !scope.channelIds.includes(source.location.channelId) ||
    (scope.expiresAt !== null && Date.parse(scope.expiresAt) <= Date.now())
  )
    return undefined;
  let acceptedWork: CollectiveWorkProjection | undefined;
  if (sourceMessage.source?.meta?.workRequest === 'entrust') {
    try {
      const work = await connector.readAssignedWorkByAssignment(source.connectionId, source.eventId);
      if (!collectiveWorkAssignmentMatches(source, work) || (work.executionAuthority?.revision ?? 1) !== 1)
        return undefined;
      acceptedWork = work;
    } catch (error) {
      if (error && typeof error === 'object' && 'causeCode' in error && error.causeCode === 'WORK_NOT_FOUND')
        return undefined;
      throw error;
    }
  }
  const grant: RegisteredCustodyGrantV1 = {
    grantRef: `collective-host:${source.connectionId}:${catId}`,
    revision: scopeRevision,
    producerRef: 'host:collective-standing-work',
    grantOwnerRef: `user:${route.localOwnerUserId}`,
    grantOwnerRevision: scopeRevision,
    allowedSourceScope: [`message:${sourceMessage.id}`],
    admissionAuthority: 'task_admit_or_resume',
    validity: { state: 'current', expiresAt: scope.expiresAt },
    idempotencySource: 'source_ref_and_revision',
  };
  return { grant, acceptedWork };
}
