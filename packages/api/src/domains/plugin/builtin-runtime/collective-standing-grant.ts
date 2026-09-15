import type { CollectiveConnector } from '@cat-cafe/collective-connector';
import { collectiveSourceIdentitySchema, type RegisteredCustodyGrantV1 } from '@cat-cafe/shared';
import type { StoredMessage } from '../../cats/services/stores/ports/MessageStore.js';

/** Derives a current grant from the existing Host binding. No second permission store. */
export async function resolveCollectiveStandingGrant(
  connector: CollectiveConnector | undefined,
  sourceMessage: StoredMessage,
  catId: string,
) {
  const parsed = collectiveSourceIdentitySchema.safeParse(sourceMessage.source?.meta?.participation);
  if (
    !connector ||
    !parsed.success ||
    parsed.data.catId !== catId ||
    parsed.data.actor.kind !== 'human' ||
    sourceMessage.source?.meta?.workRequest !== 'entrust'
  )
    return undefined;
  const source = parsed.data;
  await connector.readParticipationContext(source, 0, 1);
  const route = await connector.getHostRoute(source.connectionId);
  const connection = await connector.getProjection(source.connectionId);
  const scope = route?.agentRoutes[`${connection.authorizedHumanId}:${catId}`]?.standingWork;
  if (
    !route ||
    route.localOwnerUserId !== sourceMessage.userId ||
    route.revision !== source.participationRevision ||
    !scope ||
    !scope.requestingHumanIds.includes(parsed.data.actor.humanId) ||
    !scope.channelIds.includes(source.location.channelId) ||
    (scope.expiresAt !== null && Date.parse(scope.expiresAt) <= Date.now())
  )
    return undefined;
  const grant: RegisteredCustodyGrantV1 = {
    grantRef: `collective-host:${source.connectionId}:${catId}`,
    revision: route.revision,
    producerRef: 'host:collective-standing-work',
    grantOwnerRef: `user:${route.localOwnerUserId}`,
    grantOwnerRevision: route.revision,
    allowedSourceScope: [`message:${sourceMessage.id}`],
    admissionAuthority: 'task_admit_or_resume',
    validity: { state: 'current', expiresAt: scope.expiresAt },
    idempotencySource: 'source_ref_and_revision',
  };
  return { grant, threadId: scope.threadId };
}
