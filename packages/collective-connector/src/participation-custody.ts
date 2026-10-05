import {
  type CollectiveParticipationDeclaration,
  type CollectiveSourceIdentity,
  participationSourceIsCurrent,
} from '@cat-cafe/shared';
import type { ConnectorConnectionState, ConnectorState, HostRouteConfig } from './state.js';

export function requireParticipation(state: ConnectorState, source: CollectiveSourceIdentity) {
  const connection = state.connections[source.connectionId];
  const route = state.hostRoutes[source.connectionId];
  const binding =
    connection?.authorizedHumanId && route
      ? resolveMaterializedParticipation(route, connection.authorizedHumanId, source.catId, source.location.channelId)
      : undefined;
  if (
    !connection ||
    connection.authorityStatus !== 'connected' ||
    !connection.endpointCredential ||
    connection.serviceInstanceId !== source.serviceInstanceId ||
    connection.collectiveId !== source.collectiveId ||
    !route ||
    !participationSourceIsCurrent(route, source.catId, source.location.channelId, source.participationRevision) ||
    binding?.catId !== source.catId
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
    agents: materializedAgents(connection, route),
  };
}

export function resolveMaterializedParticipation(
  route: HostRouteConfig,
  authorizedHumanId: string,
  catId: string,
  channelId: string,
): { catId: string; displayName: string; channelId: string; threadId: string } | undefined {
  const channelRoutes = route.channelRoutes ?? {};
  if (Object.keys(channelRoutes).length) {
    const endpoint = channelRoutes[channelId];
    const participant = endpoint?.participants[catId];
    return endpoint && participant
      ? { catId, displayName: participant.displayName, channelId, threadId: endpoint.threadId }
      : undefined;
  }
  const binding = route.agentRoutes[`${authorizedHumanId}:${catId}`];
  return binding?.participation?.channelIds.includes(channelId)
    ? { catId, displayName: binding.participation.displayName, channelId, threadId: binding.threadId }
    : undefined;
}

function materializedAgents(connection: ConnectorConnectionState, route: HostRouteConfig) {
  const channelRoutes = route.channelRoutes ?? {};
  if (!Object.keys(channelRoutes).length) {
    return Object.entries(route.agentRoutes).flatMap(([key, binding]) => {
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
    });
  }
  const agents = new Map<
    string,
    { catId: string; displayName: string; channelIds: string[]; description?: string; avatarDataUrl?: string }
  >();
  for (const [channelId, endpoint] of Object.entries(channelRoutes)) {
    if (endpoint.channelId !== channelId)
      throw participationError('PARTICIPATION_INVALID', 'Channel route identity must match its registered key');
    for (const [catId, participant] of Object.entries(endpoint.participants)) {
      const existing = agents.get(catId);
      if (existing && existing.displayName !== participant.displayName)
        throw participationError('PARTICIPATION_INVALID', 'One participant identity cannot have conflicting names');
      if (existing) existing.channelIds.push(channelId);
      else
        agents.set(catId, {
          catId,
          displayName: participant.displayName,
          channelIds: [channelId],
          ...route.publicProfiles?.[catId],
        });
    }
  }
  return [...agents.values()]
    .map((agent) => ({ ...agent, channelIds: agent.channelIds.sort() }))
    .sort((left, right) => left.catId.localeCompare(right.catId));
}

export function participationError(code: string, message: string) {
  return Object.assign(new Error(message), { code });
}
