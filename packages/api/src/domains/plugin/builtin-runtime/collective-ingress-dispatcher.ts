import type {
  CollectiveConnector,
  ConnectorInboxItem,
  ConnectorProjection,
  ConnectorRouteReceipt,
  HostRouteConfig,
} from '@cat-cafe/collective-connector';
import { resolveMaterializedParticipation } from '@cat-cafe/collective-connector';
import {
  type CatId,
  type CollectiveEventEnvelope,
  type CollectiveSourceIdentity,
  collectiveEventSourceIdentity,
  participationSourceIsCurrent,
} from '@cat-cafe/shared';

import type { InvocationQueue } from '../../cats/services/agents/invocation/InvocationQueue.js';
import type { IMessageStore, StoredMessage } from '../../cats/services/stores/ports/MessageStore.js';
import { routeCollectiveChannelEvent } from './collective-channel-ingress.js';
import {
  attentionSource,
  collectiveSender,
  collectiveSource,
  emitConnectorMessage,
  ingressError,
  ingressIdempotencyKey,
  missingAgentRoute,
  routeFailure,
} from './collective-ingress-routing.js';
import { persistCollectiveWorkNotice } from './collective-work-ingress.js';

interface CollectiveIngressConnectorPort
  extends Pick<
    CollectiveConnector,
    | 'getProjection'
    | 'getHostRoute'
    | 'listInboxForRouting'
    | 'beginInboxRouting'
    | 'completeInboxRouting'
    | 'failInboxRouting'
    | 'readParticipationContext'
  > {
  readonly readWorkRoutingContext?: CollectiveConnector['readWorkRoutingContext'];
}

interface CollectiveIngressThread {
  readonly id: string;
  readonly createdBy: string;
  readonly participants?: readonly string[];
  readonly deletedAt?: number | null;
}

export interface CollectiveIngressDispatcherOptions {
  readonly admitStandingWork?: (source: StoredMessage, catId: CatId) => Promise<void>;
  readonly resumeWorkRevision?: (source: StoredMessage, event: CollectiveEventEnvelope, catId: CatId) => Promise<void>;
  readonly connector: CollectiveIngressConnectorPort;
  readonly threadStore: {
    get(threadId: string): CollectiveIngressThread | null | Promise<CollectiveIngressThread | null>;
  };
  readonly messageStore: IMessageStore;
  readonly invocationQueue: Pick<InvocationQueue, 'send'>;
  readonly socketManager: {
    broadcastToRoom(room: string, event: string, data: unknown): void;
    emitToUser?(userId: string, event: string, data: unknown): void;
  };
  readonly isCatAvailable: (catId: string) => boolean;
  readonly now?: () => number;
}

export interface CollectiveIngressDispatchResult {
  readonly routed: number;
  readonly failed: number;
  readonly skipped: number;
}

export class CollectiveIngressDispatcher {
  readonly #now: () => number;

  constructor(private readonly options: CollectiveIngressDispatcherOptions) {
    this.#now = options.now ?? Date.now;
  }

  async dispatchConnection(connectionId: string): Promise<CollectiveIngressDispatchResult> {
    const projection = await this.options.connector.getProjection(connectionId);
    const route = await this.options.connector.getHostRoute(connectionId);
    if (!route) return { routed: 0, failed: 0, skipped: 0 };
    const pending = await this.options.connector.listInboxForRouting(connectionId);
    const result = { routed: 0, failed: 0, skipped: 0 };
    for (const candidate of pending) {
      let item: ConnectorInboxItem;
      try {
        item = await this.options.connector.beginInboxRouting(connectionId, candidate.event.eventId, route.revision);
      } catch {
        continue;
      }
      let receipt: ConnectorRouteReceipt;
      try {
        receipt = await this.routeEvent(projection, route, item.event);
      } catch (error) {
        const failure = routeFailure(error);
        try {
          await this.options.connector.failInboxRouting(connectionId, item.event.eventId, route.revision, failure);
        } catch {
          // A concurrent config change owns the next retry. The durable item remains routing.
        }
        result.failed += 1;
        continue;
      }
      try {
        await this.options.connector.completeInboxRouting(connectionId, item.event.eventId, route.revision, receipt);
      } catch {
        // The Host effect may already be durable. Keep the item in `routing` so
        // the same idempotency key can repair the receipt without a route edit.
        result.failed += 1;
        continue;
      }
      if (receipt.kind === 'local_echo' || receipt.kind === 'not_local') result.skipped += 1;
      else result.routed += 1;
    }
    return result;
  }

  private async routeEvent(
    connection: ConnectorProjection,
    route: HostRouteConfig,
    event: CollectiveEventEnvelope,
  ): Promise<ConnectorRouteReceipt> {
    if (
      event.actor.kind === 'agent' &&
      event.actor.provenance.connectionId === connection.connectionId &&
      !event.workAcceptanceNotice &&
      !event.workExecutionNotice
    ) {
      return { kind: 'local_echo' };
    }
    const authorizedHumanId = connection.authorizedHumanId;
    if (!authorizedHumanId) throw ingressError('IDENTITY_REBIND_REQUIRED', 'Connection has no bound Human');

    if (event.target.kind === 'human') {
      return event.target.humanId === authorizedHumanId
        ? this.persistVisibleEvent(route, event, route.humanNotificationThreadId)
        : { kind: 'not_local' };
    }
    if (event.target.kind === 'agent') {
      return this.routeAgentEvent(connection, route, event, event.target, authorizedHumanId);
    }
    return this.routeChannelEvent(connection, route, event);
  }

  private async routeAgentEvent(
    connection: ConnectorProjection,
    route: HostRouteConfig,
    event: CollectiveEventEnvelope,
    target: Extract<CollectiveEventEnvelope['target'], { kind: 'agent' }>,
    authorizedHumanId: string,
  ): Promise<ConnectorRouteReceipt> {
    if (target.humanId !== authorizedHumanId) return { kind: 'not_local' };
    const source = collectiveEventSourceIdentity(event);
    if (source && source.connectionId !== connection.connectionId) return { kind: 'not_local' };
    if (
      !source ||
      !participationSourceIsCurrent(route, source.catId, source.location.channelId, source.participationRevision) ||
      source.catId !== target.agentId
    ) {
      throw ingressError('PARTICIPATION_REVOKED', 'Exact public participation is unavailable for this event');
    }
    const agentRoute = resolveMaterializedParticipation(
      route,
      authorizedHumanId,
      target.agentId,
      source.location.channelId,
    );
    if (!agentRoute) throw missingAgentRoute(route, authorizedHumanId, target.agentId);
    if (!this.options.isCatAvailable(agentRoute.catId)) {
      throw ingressError('ROUTE_CAT_UNAVAILABLE', 'Configured Cat is unavailable');
    }
    const thread = await this.requireThread(route, agentRoute.threadId);
    if (!thread.participants?.includes(agentRoute.catId)) {
      throw ingressError('ROUTE_CAT_NOT_IN_THREAD', 'Configured Cat is not a participant in the destination Thread');
    }
    await this.options.connector.readParticipationContext(source, 0, 1);
    return this.persistAgentEvent(route, event, agentRoute.threadId, agentRoute.catId);
  }

  private routeChannelEvent(connection: ConnectorProjection, route: HostRouteConfig, event: CollectiveEventEnvelope) {
    return routeCollectiveChannelEvent({
      connection,
      route,
      event,
      connector: this.options.connector,
      isCatAvailable: this.options.isCatAvailable,
      persistVisible: (threadId) => this.persistVisibleEvent(route, event, threadId),
      persistAgent: (threadId, catId, source) => this.persistAgentEvent(route, event, threadId, catId, source),
      requireThread: (threadId) => this.requireThread(route, threadId),
    });
  }

  private async persistVisibleEvent(
    route: HostRouteConfig,
    event: CollectiveEventEnvelope,
    threadId: string,
  ): Promise<Extract<ConnectorRouteReceipt, { kind: 'thread_message' }>> {
    await this.requireThread(route, threadId);
    const source = collectiveSource(event);
    const stored = await this.options.messageStore.appendIdempotent({
      threadId,
      userId: route.localOwnerUserId,
      from: collectiveMessageFrom(event),
      content: event.body,
      source,
      mentions: [],
      timestamp: Date.parse(event.acceptedAt),
      idempotencyKey: ingressIdempotencyKey(event),
    });
    if (!stored.idempotent)
      emitConnectorMessage(this.options.socketManager, threadId, stored.message.id, event, source);
    return { kind: 'thread_message', threadId, messageId: stored.message.id };
  }

  private async persistAgentEvent(
    route: HostRouteConfig,
    event: CollectiveEventEnvelope,
    threadId: string,
    catId: string,
    sourceIdentity?: CollectiveSourceIdentity,
  ): Promise<Extract<ConnectorRouteReceipt, { kind: 'thread_message' }>> {
    const idempotencyKey = ingressIdempotencyKey(event);
    if (event.workAcceptanceNotice || event.workExecutionNotice)
      return persistCollectiveWorkNotice(this.options, route, event, threadId, catId, sourceIdentity);
    if (event.workRequest === 'revise') {
      if (!event.workRevisionNotice || !this.options.resumeWorkRevision) {
        throw ingressError('WORK_REVISION_UNAVAILABLE', 'Host cannot resume this Work revision');
      }
      const source = collectiveSource(event, sourceIdentity);
      const stored = await this.options.messageStore.appendIdempotent({
        threadId,
        userId: route.localOwnerUserId,
        from: collectiveMessageFrom(event),
        content: event.body,
        source,
        mentions: [catId as CatId],
        timestamp: Date.parse(event.acceptedAt),
        idempotencyKey,
        extra: { targetCats: [catId] },
      });
      await this.options.resumeWorkRevision(stored.message, event, catId as CatId);
      if (!stored.idempotent)
        emitConnectorMessage(this.options.socketManager, threadId, stored.message.id, event, source);
      return { kind: 'thread_message', threadId, messageId: stored.message.id, catId };
    }
    const source = collectiveSource(event, sourceIdentity);
    const from = collectiveMessageFrom(event);
    const stored = await this.options.invocationQueue.send(
      this.options.messageStore,
      {
        threadId,
        userId: route.localOwnerUserId,
        from,
        content: event.body,
        source,
        mentions: [catId as CatId],
        timestamp: Date.parse(event.acceptedAt),
        idempotencyKey,
        deliveryStatus: 'queued',
        extra: { targetCats: [catId] },
      },
      {
        threadId,
        userId: route.localOwnerUserId,
        sourceId: idempotencyKey,
        kind: 'conversation_input',
        from,
        ownerAuthProvenance: 'unknown',
        executionScope: 'collective-participation',
        idempotencyKey,
        content: event.body,
        targetCats: [catId],
        intent: 'execute',
        suggestedSkill: 'collective-participation',
        onQueueEntriesAdmitted: async (_entries, message) => {
          if (event.workRequest === 'entrust' && message)
            await this.options.admitStandingWork?.(message, catId as CatId);
        },
      },
    );
    if (stored.outcome === 'full') throw ingressError('ROUTE_QUEUE_FULL', 'Configured Cat queue is full');
    if (!stored.deduped) {
      this.options.socketManager.emitToUser?.(route.localOwnerUserId, 'messages_queued', {
        threadId,
        messageIds: [stored.message.id],
        messages: [stored.message],
      });
    }

    return { kind: 'thread_message', threadId, messageId: stored.message.id, catId };
  }

  private async requireThread(route: HostRouteConfig, threadId: string): Promise<CollectiveIngressThread> {
    const thread = await this.options.threadStore.get(threadId);
    if (!thread || thread.deletedAt || thread.createdBy !== route.localOwnerUserId) {
      throw ingressError('ROUTE_THREAD_UNAVAILABLE', 'Configured Thread is unavailable to this owner');
    }
    return thread;
  }
}

function collectiveMessageFrom(event: CollectiveEventEnvelope) {
  const sender = collectiveSender(event);
  return { kind: 'external' as const, connectorId: 'collective', sender };
}
