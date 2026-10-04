import { type CollectiveConnector, resolveMaterializedParticipation } from '@cat-cafe/collective-connector';
import {
  type CollectiveExecutionGrant,
  collectiveSourceIdentitySchema,
  participationSourceIsCurrent,
} from '@cat-cafe/shared';
import type { IMessageStore } from '../../cats/services/stores/ports/MessageStore.js';
import { collectiveContextError } from './collective-context-refs.js';
import { requireCurrentReconsiderationSource } from './collective-work/collective-reconsideration-source.js';

interface ParticipationSourceOptions {
  readonly connector: () => CollectiveConnector | undefined;
  readonly messageStore: Pick<IMessageStore, 'getById'>;
  readonly threadStore: {
    get(
      id: string,
    ):
      | { createdBy: string; deletedAt?: number | null }
      | null
      | Promise<{ createdBy: string; deletedAt?: number | null } | null>;
  };
}
export interface CollectiveInvocationSource {
  readonly userId: string;
  readonly threadId: string;
  readonly catId: string;
  readonly originTriggerMessageId?: string;
}
export async function resolveCollectiveParticipationSource(
  options: ParticipationSourceOptions,
  input: CollectiveInvocationSource,
  sourceCatId: string,
  actingCatId = sourceCatId,
) {
  if (!input.originTriggerMessageId) return undefined;
  const message = await options.messageStore.getById(input.originTriggerMessageId);
  if (message?.source?.connector !== 'collective') return undefined;
  if (
    message.userId !== input.userId ||
    message.threadId !== input.threadId ||
    message.deletedAt ||
    message.recall ||
    message._tombstone ||
    message.catId !== null
  ) {
    throw collectiveContextError('RETURN_UNAVAILABLE', 'Collective source Message is unavailable');
  }
  const parsed = collectiveSourceIdentitySchema.safeParse(message.source.meta?.participation);
  if (!parsed.success || parsed.data.catId !== sourceCatId)
    throw collectiveContextError('RETURN_UNAVAILABLE', 'Source has no exact participant identity');
  const source = parsed.data;
  const connector = options.connector();
  if (!connector) throw collectiveContextError('RETURN_UNAVAILABLE', 'Collective Connector is unavailable');
  const ownerWakePurpose = await requireCurrentReconsiderationSource({
    connector,
    messages: options.messageStore,
    message,
    source,
    ownerUserId: input.userId,
  });
  const context = await connector.readParticipationContext(source);
  const route = await connector.getHostRoute(source.connectionId);
  const connection = await connector.getProjection(source.connectionId);
  const sourceBinding =
    route && connection.authorizedHumanId
      ? resolveMaterializedParticipation(route, connection.authorizedHumanId, sourceCatId, source.location.channelId)
      : undefined;
  const actingBinding =
    actingCatId === sourceCatId
      ? sourceBinding
      : route && connection.authorizedHumanId
        ? resolveMaterializedParticipation(route, connection.authorizedHumanId, actingCatId, source.location.channelId)
        : undefined;
  const thread = await options.threadStore.get(message.threadId);
  if (
    !route ||
    route.localOwnerUserId !== input.userId ||
    !participationSourceIsCurrent(route, sourceCatId, source.location.channelId, source.participationRevision) ||
    thread?.createdBy !== input.userId ||
    thread.deletedAt ||
    !sourceBinding ||
    !actingBinding
  )
    throw collectiveContextError('PARTICIPATION_REVOKED', 'Host participation binding changed');
  const grant: CollectiveExecutionGrant = {
    kind: 'collective-participation',
    originTriggerMessageId: message.id,
    source,
  };
  return {
    ownerWakePurpose,
    grant,
    sourceRef: `message:${message.id}`,
    source,
    context,
    displayName: actingBinding.displayName,
  };
}
