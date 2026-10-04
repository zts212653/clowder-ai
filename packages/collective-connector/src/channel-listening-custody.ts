import { z } from 'zod';
import { participationError, resolveMaterializedParticipation } from './participation-custody.js';
import type { ConnectorPersistence } from './persistence.js';
import type { MutableConnectorState } from './state.js';

const coordinates = {
  channelId: z.string().trim().min(1).max(160),
  expectedAttentionRevision: z.number().int().nonnegative(),
};
export const channelListeningInputSchema = z.discriminatedUnion('mode', [
  z.object({ ...coordinates, mode: z.literal('mentions') }).strict(),
  z.object({ ...coordinates, mode: z.literal('all'), dutyCatId: z.string().trim().min(1).max(120) }).strict(),
]);
export type ChannelListeningInput = z.infer<typeof channelListeningInputSchema>;

/** Local owner attention preference; it never produces, widens or revokes a work grant. */
export async function setChannelListening(input: {
  persistence: ConnectorPersistence;
  now: () => number;
  connectionId: string;
  ownerUserId: string;
  unsafeInput: ChannelListeningInput;
}) {
  const update = channelListeningInputSchema.parse(input.unsafeInput);
  return input.persistence.transaction((state) => {
    const { connection, route } = requireListeningOwner(state, input.connectionId, input.ownerUserId);
    if (route.attentionRevision !== update.expectedAttentionRevision)
      throw participationError('ATTENTION_REVISION_CONFLICT', 'Channel attention settings changed');
    if (!route.channelRoutes[update.channelId])
      throw participationError('ROUTE_CHANNEL_UNCONFIGURED', 'Channel has no configured receiving relationship');
    if (
      update.mode === 'all' &&
      !resolveMaterializedParticipation(route, connection.authorizedHumanId, update.dutyCatId, update.channelId)
    )
      throw participationError('PARTICIPATION_REVOKED', 'Duty Cat is not participating in this Channel');
    const current = route.channelListening?.[update.channelId];
    if (
      current?.mode === update.mode &&
      (update.mode === 'mentions' || (current.mode === 'all' && current.dutyCatId === update.dutyCatId))
    )
      return structuredClone(route);
    const common = { revision: route.attentionRevision + 1, updatedAt: new Date(input.now()).toISOString() };
    route.channelListening ??= {};
    route.channelListening[update.channelId] =
      update.mode === 'all' ? { ...common, mode: 'all', dutyCatId: update.dutyCatId } : { ...common, mode: 'mentions' };
    route.attentionRevision = common.revision;
    return structuredClone(route);
  });
}

function requireListeningOwner(state: MutableConnectorState, connectionId: string, ownerUserId: string) {
  const connection = state.connections[connectionId];
  const route = state.hostRoutes[connectionId];
  if (!connection || connection.authorityStatus !== 'connected' || !connection.authorizedHumanId || !route)
    throw participationError('PARTICIPATION_REVOKED', 'Current Channel participation is unavailable');
  if (route.localOwnerUserId !== ownerUserId)
    throw participationError('CONNECTOR_OWNER_MISMATCH', 'Only this local owner can configure listening');
  return { connection: { ...connection, authorizedHumanId: connection.authorizedHumanId }, route };
}
