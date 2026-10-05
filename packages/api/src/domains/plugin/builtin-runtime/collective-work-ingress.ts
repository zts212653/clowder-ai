import type { ConnectorRouteReceipt, HostRouteConfig } from '@cat-cafe/collective-connector';
import type { CatId, CollectiveEventEnvelope, CollectiveSourceIdentity } from '@cat-cafe/shared';
import type { CollectiveIngressDispatcherOptions } from './collective-ingress-dispatcher.js';
import {
  collectiveSource,
  emitConnectorMessage,
  ingressError,
  ingressIdempotencyKey,
} from './collective-ingress-routing.js';

export async function persistCollectiveWorkNotice(
  options: CollectiveIngressDispatcherOptions,
  route: HostRouteConfig,
  event: CollectiveEventEnvelope,
  threadId: string,
  catId: string,
  sourceIdentity?: CollectiveSourceIdentity,
): Promise<Extract<ConnectorRouteReceipt, { kind: 'thread_message' }>> {
  if (!options.admitStandingWork)
    throw ingressError('OWNER_ADMISSION_UNAVAILABLE', 'Host acceptance producer is unavailable');
  const source = collectiveSource(event, sourceIdentity);
  const stored = await options.messageStore.appendIdempotent({
    threadId,
    userId: route.localOwnerUserId,
    catId: null,
    content: event.body,
    source,
    mentions: [],
    timestamp: Date.parse(event.acceptedAt),
    idempotencyKey: ingressIdempotencyKey(event),
  });
  await options.admitStandingWork(stored.message, catId as CatId);
  if (!stored.idempotent) emitConnectorMessage(options.socketManager, threadId, stored.message.id, event, source);
  return { kind: 'thread_message', threadId, messageId: stored.message.id, catId };
}
