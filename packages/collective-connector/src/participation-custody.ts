import type { CollectiveParticipationDeclaration, CollectiveSourceIdentity } from '@cat-cafe/shared';
import type { ConnectorConnectionState, ConnectorState, HostRouteConfig } from './state.js';

export function requireParticipation(state: ConnectorState, source: CollectiveSourceIdentity) {
  const connection = state.connections[source.connectionId];
  const route = state.hostRoutes[source.connectionId];
  const binding = connection?.authorizedHumanId
    ? route?.agentRoutes[`${connection.authorizedHumanId}:${source.catId}`]
    : undefined;
  if (
    !connection ||
    connection.authorityStatus !== 'connected' ||
    !connection.endpointCredential ||
    connection.serviceInstanceId !== source.serviceInstanceId ||
    connection.collectiveId !== source.collectiveId ||
    route?.revision !== source.participationRevision ||
    binding?.catId !== source.catId ||
    !binding.participation?.channelIds.includes(source.location.channelId)
  ) {
    throw participationError('PARTICIPATION_REVOKED', 'Public participation is no longer authorized');
  }
  return { connection, route, binding, credential: connection.endpointCredential };
}

export function participationDeclaration(
  connection: ConnectorConnectionState,
  route: HostRouteConfig,
): CollectiveParticipationDeclaration {
  return {
    serviceInstanceId: connection.serviceInstanceId,
    collectiveId: connection.collectiveId,
    connectionId: connection.connectionId,
    revision: route.revision,
    agents: Object.entries(route.agentRoutes).flatMap(([key, binding]) => {
      if (!binding.participation) return [];
      if (key !== `${connection.authorizedHumanId}:${binding.catId}`)
        throw participationError('PARTICIPATION_INVALID', 'Participant identity must match the registered Cat');
      return [
        {
          catId: binding.catId,
          displayName: binding.participation.displayName,
          channelIds: [...binding.participation.channelIds],
        },
      ];
    }),
  };
}

export function participationError(code: string, message: string) {
  return Object.assign(new Error(message), { code });
}
