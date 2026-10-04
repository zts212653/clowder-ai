import { z } from 'zod';
import { participationError, resolveMaterializedParticipation } from './participation-custody.js';
import type { ConnectorPersistence } from './persistence.js';
import type { HostRouteConfig, MutableConnectorState } from './state.js';

const standingInterestInputSchema = z
  .object({
    catId: z.string().trim().min(1).max(120),
    channelId: z.string().trim().min(1).max(160),
    state: z.enum(['listen', 'withdraw']),
  })
  .strict();

export type StandingInterestInput = z.infer<typeof standingInterestInputSchema>;

export async function setStandingInterest(input: {
  readonly persistence: ConnectorPersistence;
  readonly now: () => number;
  readonly connectionId: string;
  readonly unsafeInput: StandingInterestInput;
  readonly expectedRevision: number;
}): Promise<HostRouteConfig> {
  const update = standingInterestInputSchema.parse(input.unsafeInput);
  return input.persistence.transaction((state) => {
    const { authorizedHumanId, route } = requireInterestAuthority(state, input.connectionId);
    if (route.attentionRevision !== input.expectedRevision) {
      throw participationError('ATTENTION_REVISION_CONFLICT', 'Collective standing interest changed');
    }
    if (
      update.state === 'listen' &&
      !resolveMaterializedParticipation(route, authorizedHumanId, update.catId, update.channelId)
    ) {
      throw participationError('PARTICIPATION_REVOKED', 'Cat is not participating in this Channel');
    }
    const current = route.standingInterests[update.channelId]?.[update.catId];
    const status = update.state === 'listen' ? 'active' : 'withdrawn';
    if (current?.status === status) return structuredClone(route) as HostRouteConfig;

    const revision = route.attentionRevision + 1;
    route.standingInterests = {
      ...route.standingInterests,
      [update.channelId]: {
        ...(route.standingInterests[update.channelId] ?? {}),
        [update.catId]: {
          catId: update.catId,
          kind: 'response_requests',
          status,
          revision,
          updatedAt: new Date(input.now()).toISOString(),
        },
      },
    };
    route.attentionRevision = revision;
    return structuredClone(route) as HostRouteConfig;
  });
}

function requireInterestAuthority(state: MutableConnectorState, connectionId: string) {
  const connection = state.connections[connectionId];
  const route = state.hostRoutes[connectionId];
  if (!connection || connection.authorityStatus !== 'connected' || !connection.authorizedHumanId || !route) {
    throw participationError('PARTICIPATION_REVOKED', 'Collective participation is unavailable');
  }
  return { authorizedHumanId: connection.authorizedHumanId, route };
}
