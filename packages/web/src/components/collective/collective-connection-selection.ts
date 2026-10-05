import type { CollectiveConnectionProjection } from './collective-client';

export function preferredConnection(
  connections: readonly CollectiveConnectionProjection[],
  selectedId?: string,
): CollectiveConnectionProjection | undefined {
  const live = connections.filter((connection) => connection.authorityStatus !== 'revoked');
  return (
    live.find((connection) => connection.connectionId === selectedId) ??
    (live.length === 1 ? live[0] : live.length === 0 && connections.length === 1 ? connections[0] : undefined)
  );
}

export function hasActiveCollectiveConnection(
  connections: readonly CollectiveConnectionProjection[],
  serviceInstanceId: string,
  collectiveId: string,
): boolean {
  return connections.some(
    (connection) =>
      connection.authorityStatus !== 'revoked' &&
      connection.serviceInstanceId === serviceInstanceId &&
      connection.collectiveId === collectiveId,
  );
}
