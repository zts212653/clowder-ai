import type {
  CollectiveConnector,
  ConnectorInboxItem,
  ConnectorProjection,
  ConnectorRouteReceipt,
  HostRouteConfig,
} from '@cat-cafe/collective-connector';
import type { CatId, CollectiveEventEnvelope, ConnectorSource } from '@cat-cafe/shared';

import type { InvocationQueue } from '../../cats/services/agents/invocation/InvocationQueue.js';
import type { QueueProcessor } from '../../cats/services/agents/invocation/QueueProcessor.js';
import type { IMessageStore } from '../../cats/services/stores/ports/MessageStore.js';

interface CollectiveIngressConnectorPort
  extends Pick<
    CollectiveConnector,
    | 'getProjection'
    | 'getHostRoute'
    | 'listInboxForRouting'
    | 'beginInboxRouting'
    | 'completeInboxRouting'
    | 'failInboxRouting'
  > {}

interface CollectiveIngressThread {
  readonly id: string;
  readonly createdBy: string;
  readonly participants?: readonly string[];
  readonly deletedAt?: number | null;
}

export interface CollectiveIngressDispatcherOptions {
  readonly connector: CollectiveIngressConnectorPort;
  readonly threadStore: {
    get(threadId: string): CollectiveIngressThread | null | Promise<CollectiveIngressThread | null>;
  };
  readonly messageStore: IMessageStore;
  readonly invocationQueue: Pick<InvocationQueue, 'appendAndEnqueueDurable'>;
  readonly queueProcessor: Pick<QueueProcessor, 'processNext'>;
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
    if (event.actor.kind === 'agent' && event.actor.provenance.connectionId === connection.connectionId) {
      return { kind: 'local_echo' };
    }
    const authorizedHumanId = connection.authorizedHumanId;
    if (!authorizedHumanId) throw ingressError('IDENTITY_REBIND_REQUIRED', 'Connection has no bound Human');

    if (event.target.kind === 'human') {
      if (event.target.humanId !== authorizedHumanId) {
        return { kind: 'not_local' };
      }
      return this.persistVisibleEvent(route, event, route.humanNotificationThreadId);
    }
    if (event.target.kind === 'agent') {
      if (event.target.humanId !== authorizedHumanId) {
        return { kind: 'not_local' };
      }
      const agentRoute = route.agentRoutes[agentRouteKey(event.target.humanId, event.target.agentId)];
      if (!agentRoute) throw ingressError('ROUTE_AGENT_UNCONFIGURED', 'Agent target has no Host route');
      if (!this.options.isCatAvailable(agentRoute.catId)) {
        throw ingressError('ROUTE_CAT_UNAVAILABLE', 'Configured Cat is unavailable');
      }
      const thread = await this.requireThread(route, agentRoute.threadId);
      if (!thread.participants?.includes(agentRoute.catId)) {
        throw ingressError('ROUTE_CAT_NOT_IN_THREAD', 'Configured Cat is not a participant in the destination Thread');
      }
      return this.persistAgentEvent(route, event, agentRoute.threadId, agentRoute.catId);
    }
    return this.persistVisibleEvent(route, event, route.defaultIngressThreadId);
  }

  private async persistVisibleEvent(
    route: HostRouteConfig,
    event: CollectiveEventEnvelope,
    threadId: string,
  ): Promise<ConnectorRouteReceipt> {
    await this.requireThread(route, threadId);
    const source = collectiveSource(event);
    const idempotencyKey = ingressIdempotencyKey(event);
    const existing = await this.options.messageStore.getByIdempotencyKey(
      route.localOwnerUserId,
      threadId,
      idempotencyKey,
    );
    const message = await this.options.messageStore.append({
      from: { kind: 'external', connectorId: 'collective', sender: collectiveSender(event) },
      threadId,
      userId: route.localOwnerUserId,
      content: event.body,
      source,
      mentions: [],
      timestamp: Date.parse(event.acceptedAt),
      idempotencyKey,
    });
    if (!existing) emitConnectorMessage(this.options.socketManager, threadId, message.id, event, source);
    return { kind: 'thread_message', threadId, messageId: message.id };
  }

  private async persistAgentEvent(
    route: HostRouteConfig,
    event: CollectiveEventEnvelope,
    threadId: string,
    catId: string,
  ): Promise<ConnectorRouteReceipt> {
    const idempotencyKey = ingressIdempotencyKey(event);
    const source = collectiveSource(event);
    const from = { kind: 'external' as const, connectorId: 'collective', sender: collectiveSender(event) };
    const enqueue = await this.options.invocationQueue.appendAndEnqueueDurable(
      this.options.messageStore,
      {
        from,
        threadId,
        userId: route.localOwnerUserId,
        content: event.body,
        source,
        mentions: [catId as CatId],
        timestamp: Date.parse(event.acceptedAt),
        idempotencyKey,
        deliveryStatus: 'queued',
        extra: { targetCats: [catId] },
      },
      {
        from,
        threadId,
        userId: route.localOwnerUserId,
        kind: 'conversation_input',
        ownerAuthProvenance: 'strict',
        idempotencyKey,
        content: event.body,
        targetCats: [catId],
        intent: 'execute',
        autoExecute: true,
      },
    );
    if (enqueue.outcome === 'full' || !enqueue.entry) {
      throw ingressError('ROUTE_QUEUE_FULL', 'Configured Cat queue is full');
    }
    if (!enqueue.deduped) {
      this.options.socketManager.emitToUser?.(route.localOwnerUserId, 'messages_queued', {
        threadId,
        messageIds: [enqueue.message.id],
        messages: [enqueue.message],
      });
    }
    try {
      await this.options.queueProcessor.processNext(threadId, route.localOwnerUserId);
    } catch {
      // Durable Queue ledger owns execution after admission.
    }
    return { kind: 'thread_message', threadId, messageId: enqueue.message.id, catId };
  }

  private async requireThread(route: HostRouteConfig, threadId: string): Promise<CollectiveIngressThread> {
    const thread = await this.options.threadStore.get(threadId);
    if (!thread || thread.deletedAt || thread.createdBy !== route.localOwnerUserId) {
      throw ingressError('ROUTE_THREAD_UNAVAILABLE', 'Configured Thread is unavailable to this owner');
    }
    return thread;
  }
}

function agentRouteKey(humanId: string, agentId: string): string {
  return `${humanId}:${agentId}`;
}

function ingressIdempotencyKey(event: CollectiveEventEnvelope): string {
  return `collective-ingress:${event.serviceInstanceId}:${event.collectiveId}:${event.eventId}`;
}

function collectiveSender(event: CollectiveEventEnvelope): { id: string; name: string } {
  if (event.actor.kind === 'human') return { id: event.actor.humanId, name: event.actor.displayName };
  return {
    id: `${event.actor.human.humanId}:${event.actor.agent.agentId}`,
    name: `${event.actor.agent.displayName} · ${event.actor.human.displayName}`,
  };
}

function collectiveSource(event: CollectiveEventEnvelope): ConnectorSource {
  return {
    connector: 'collective',
    label: 'Collective',
    icon: 'collective',
    sender: collectiveSender(event),
    meta: {
      serviceInstanceId: event.serviceInstanceId,
      collectiveId: event.collectiveId,
      eventId: event.eventId,
      sequence: event.sequence,
      target: event.target,
    },
  };
}

function emitConnectorMessage(
  socketManager: CollectiveIngressDispatcherOptions['socketManager'],
  threadId: string,
  messageId: string,
  event: CollectiveEventEnvelope,
  source: ConnectorSource,
): void {
  socketManager.broadcastToRoom(`thread:${threadId}`, 'connector_message', {
    threadId,
    message: {
      id: messageId,
      type: 'connector',
      content: event.body,
      source,
      timestamp: Date.parse(event.acceptedAt),
    },
  });
}

function ingressError(code: string, message: string): Error & { code: string } {
  return Object.assign(new Error(message), { code });
}

function routeFailure(error: unknown): { code: string; message: string } {
  if (error instanceof Error) {
    const candidate = 'code' in error ? error.code : undefined;
    const code =
      typeof candidate === 'string' && /^[A-Z][A-Z0-9_]{1,63}$/.test(candidate) ? candidate : 'ROUTE_DELIVERY_FAILED';
    return { code, message: error.message.slice(0, 500) || 'Collective ingress routing failed' };
  }
  return { code: 'ROUTE_DELIVERY_FAILED', message: 'Collective ingress routing failed' };
}
