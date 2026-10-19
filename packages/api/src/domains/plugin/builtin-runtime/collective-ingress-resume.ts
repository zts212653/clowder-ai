import type { HostRouteConfig } from '@cat-cafe/collective-connector';
import type { CatId, CollectiveEventEnvelope, CollectiveSourceIdentity } from '@cat-cafe/shared';
import type { IMessageStore } from '../../cats/services/stores/ports/MessageStore.js';
import {
  collectiveSender,
  collectiveSource,
  emitConnectorMessage,
  ingressIdempotencyKey,
} from './collective-ingress-routing.js';

export async function appendCollectiveResumeEvent(input: {
  readonly route: HostRouteConfig;
  readonly event: CollectiveEventEnvelope;
  readonly threadId: string;
  readonly catId: string;
  readonly sourceIdentity?: CollectiveSourceIdentity;
  readonly messageStore: Pick<IMessageStore, 'appendIdempotent' | 'getByIdempotencyKey'>;
  readonly socketManager: { broadcastToRoom(room: string, event: string, data: unknown): void };
  readonly emit: boolean;
}) {
  const source = collectiveSource(input.event, input.sourceIdentity);
  const commentEventId = input.event.workWakeNotice?.reason === 'comment' ? input.event.replyToEventId : undefined;
  const existingComment = commentEventId
    ? await input.messageStore.getByIdempotencyKey(
        input.route.localOwnerUserId,
        input.threadId,
        `collective-ingress:${input.event.serviceInstanceId}:${input.event.collectiveId}:${commentEventId}`,
      )
    : null;
  if (existingComment) {
    return { source, stored: { message: existingComment, idempotent: true } };
  }
  const stored = await input.messageStore.appendIdempotent({
    threadId: input.threadId,
    userId: input.route.localOwnerUserId,
    from: { kind: 'external', connectorId: 'collective', sender: collectiveSender(input.event) },
    content: input.event.body,
    source,
    mentions: [input.catId as CatId],
    timestamp: Date.parse(input.event.acceptedAt),
    idempotencyKey: ingressIdempotencyKey(input.event),
    extra: { targetCats: [input.catId] },
  });
  if (input.emit && !stored.idempotent) {
    emitConnectorMessage(input.socketManager, input.threadId, stored.message.id, input.event, source);
  }
  return { source, stored };
}
