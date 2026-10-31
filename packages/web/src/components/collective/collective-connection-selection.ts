import type { CollectiveConnectionProjection } from './collective-client';

export function preferredConnection(
  connections: readonly CollectiveConnectionProjection[],
  selectedId?: string,
): CollectiveConnectionProjection | undefined {
  const live = connections.filter((connection) => connection.authorityStatus !== 'revoked');
  const selected = live.find((connection) => connection.connectionId === selectedId);
  if (selected) return selected;
  const ranked = [...live].sort((left, right) => {
    const liveness = Number(right.liveStatus === 'online') - Number(left.liveStatus === 'online');
    if (liveness) return liveness;
    const authority = Number(right.authorityStatus === 'connected') - Number(left.authorityStatus === 'connected');
    if (authority) return authority;
    const leftKey = `${left.serviceUrl}\0${left.serviceInstanceId}\0${left.collectiveId}\0${left.connectionId}`;
    const rightKey = `${right.serviceUrl}\0${right.serviceInstanceId}\0${right.collectiveId}\0${right.connectionId}`;
    return leftKey < rightKey ? -1 : leftKey > rightKey ? 1 : 0;
  });
  return ranked[0] ?? (connections.length === 1 ? connections[0] : undefined);
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
