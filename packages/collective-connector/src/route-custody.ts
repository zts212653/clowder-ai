import type { ConnectorPersistence } from './persistence.js';
import {
  type ConnectorConnectionState,
  type ConnectorInboxItem,
  type ConnectorRouteFailure,
  type ConnectorRouteReceipt,
  type DeepMutable,
  type HostRouteConfig,
  type SetHostRouteInput,
  setHostRouteInputSchema,
} from './state.js';

const RETRYABLE_ROUTE_FAILURE_CODES = new Set(['ROUTE_QUEUE_FULL', 'ROUTE_CAT_UNAVAILABLE']);

export async function setHostRoute(input: {
  persistence: ConnectorPersistence;
  now: () => number;
  connectionId: string;
  unsafeInput: SetHostRouteInput;
}): Promise<HostRouteConfig> {
  const routeInput = setHostRouteInputSchema.parse(input.unsafeInput);
  return input.persistence.transaction((state) => {
    requireConnection(state.connections[input.connectionId]);
    const existing = state.hostRoutes[input.connectionId];
    if (existing && existing.localOwnerUserId !== routeInput.localOwnerUserId) {
      throw new Error('Collective Host route belongs to another local owner');
    }
    const route: HostRouteConfig = {
      connectionId: input.connectionId,
      localOwnerUserId: routeInput.localOwnerUserId,
      defaultIngressThreadId: routeInput.defaultIngressThreadId,
      humanNotificationThreadId: routeInput.humanNotificationThreadId,
      agentRoutes: structuredClone(routeInput.agentRoutes),
      revision: (existing?.revision ?? 0) + 1,
      updatedAt: new Date(input.now()).toISOString(),
    };
    state.hostRoutes[input.connectionId] = route;
    return structuredClone(route);
  });
}

export function getHostRoute(persistence: ConnectorPersistence, connectionId: string): HostRouteConfig | undefined {
  const snapshot = persistence.snapshot();
  requireConnection(snapshot.connections[connectionId]);
  const route = snapshot.hostRoutes[connectionId];
  return route ? structuredClone(route) : undefined;
}

export function listInboxForRouting(persistence: ConnectorPersistence, connectionId: string): ConnectorInboxItem[] {
  const snapshot = persistence.snapshot();
  const connection = requireConnection(snapshot.connections[connectionId]);
  const routeRevision = snapshot.hostRoutes[connectionId]?.revision;
  return structuredClone(
    connection.inbox.filter(
      (item) =>
        item.disposition === 'persisted' ||
        item.disposition === 'routing' ||
        (item.disposition === 'route_failed' &&
          routeRevision !== undefined &&
          (isRetryableRouteFailure(item.routeFailure) || routeRevision > (item.routeConfigRevision ?? 0))),
    ),
  );
}

export async function beginInboxRouting(input: {
  persistence: ConnectorPersistence;
  now: () => number;
  connectionId: string;
  eventId: string;
  routeConfigRevision: number;
}): Promise<ConnectorInboxItem> {
  return input.persistence.transaction((state) => {
    requireCurrentHostRoute(state.hostRoutes[input.connectionId], input.routeConfigRevision);
    const item = requireInboxItem(state.connections[input.connectionId], input.eventId);
    if (item.disposition === 'routed') return structuredClone(item);
    if (
      item.disposition === 'route_failed' &&
      !isRetryableRouteFailure(item.routeFailure) &&
      (item.routeConfigRevision ?? 0) >= input.routeConfigRevision
    ) {
      throw new Error('Collective inbox route repair has not advanced');
    }
    item.disposition = 'routing';
    item.routeConfigRevision = input.routeConfigRevision;
    item.routeAttemptedAt = new Date(input.now()).toISOString();
    delete item.routeFailure;
    delete item.routeReceipt;
    delete item.routedAt;
    return structuredClone(item);
  });
}

export async function completeInboxRouting(input: {
  persistence: ConnectorPersistence;
  now: () => number;
  connectionId: string;
  eventId: string;
  routeConfigRevision: number;
  receipt: ConnectorRouteReceipt;
}): Promise<ConnectorInboxItem> {
  return input.persistence.transaction((state) => {
    requireCurrentHostRoute(state.hostRoutes[input.connectionId], input.routeConfigRevision);
    const item = requireInboxItem(state.connections[input.connectionId], input.eventId);
    if (item.disposition === 'routed') {
      if (JSON.stringify(item.routeReceipt) !== JSON.stringify(input.receipt)) {
        throw new Error('Collective inbox event already has another Host route receipt');
      }
      return structuredClone(item);
    }
    requireRoutingAttempt(item, input.routeConfigRevision);
    item.disposition = 'routed';
    item.routeReceipt = structuredClone(input.receipt);
    item.routedAt = new Date(input.now()).toISOString();
    delete item.routeFailure;
    return structuredClone(item);
  });
}

export async function failInboxRouting(input: {
  persistence: ConnectorPersistence;
  connectionId: string;
  eventId: string;
  routeConfigRevision: number;
  failure: ConnectorRouteFailure;
}): Promise<ConnectorInboxItem> {
  return input.persistence.transaction((state) => {
    requireCurrentHostRoute(state.hostRoutes[input.connectionId], input.routeConfigRevision);
    const item = requireInboxItem(state.connections[input.connectionId], input.eventId);
    requireRoutingAttempt(item, input.routeConfigRevision);
    item.disposition = 'route_failed';
    item.routeFailure = structuredClone(input.failure);
    delete item.routeReceipt;
    delete item.routedAt;
    return structuredClone(item);
  });
}

function requireConnection<Connection extends ConnectorConnectionState>(
  connection: Connection | undefined,
): Connection {
  if (!connection) throw new Error('Collective connection was not found');
  return connection;
}

function requireCurrentHostRoute(route: HostRouteConfig | undefined, expectedRevision: number): HostRouteConfig {
  if (!route) throw new Error('Collective Host route is not configured');
  if (route.revision !== expectedRevision) throw new Error('Collective Host route configuration changed');
  return route;
}

function requireInboxItem(
  connection: DeepMutable<ConnectorConnectionState> | undefined,
  eventId: string,
): DeepMutable<ConnectorInboxItem> {
  const item = requireConnection(connection).inbox.find((candidate) => candidate.event.eventId === eventId);
  if (!item) throw new Error('Collective inbox event was not found');
  return item;
}

function requireRoutingAttempt(item: ConnectorInboxItem, routeConfigRevision: number): void {
  if (item.disposition !== 'routing' || item.routeConfigRevision !== routeConfigRevision) {
    throw new Error('Collective inbox event does not belong to this routing attempt');
  }
}

function isRetryableRouteFailure(failure: ConnectorRouteFailure | undefined): boolean {
  return failure !== undefined && RETRYABLE_ROUTE_FAILURE_CODES.has(failure.code);
}
