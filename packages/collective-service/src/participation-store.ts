import {
  type CollectiveEventEnvelope,
  type CollectiveParticipant,
  type CollectiveParticipationDeclaration,
  collectiveConnectionCoordinatesSchema,
  collectiveParticipationDeclarationSchema,
} from '@cat-cafe/shared';
import { z } from 'zod';
import { assertConnectionCoordinates, requireAuthorizedHuman, requireConnection } from './connection-authority.js';
import { CollectiveServiceError } from './errors.js';
import { requireHumanAuthBinding, requireMembership, resolveSession } from './identity-store.js';
import type { PersistentServiceState } from './persistence.js';
import type { ServiceState } from './state.js';

export interface ParticipationRecord extends CollectiveParticipationDeclaration {
  readonly publishedAt: string;
}

const contextRequest = collectiveConnectionCoordinatesSchema
  .extend({
    catId: z.string().min(1).max(120),
    participationRevision: z.number().int().positive(),
    eventId: z.string().min(1).max(160),
    afterSequence: z.number().int().nonnegative().default(0),
    limit: z.number().int().min(1).max(100).default(30),
  })
  .strict();

export class CollectiveParticipationStore {
  constructor(
    private readonly persistence: PersistentServiceState,
    private readonly now: () => number,
  ) {}

  async publish(endpointCredential: string, unsafeInput: unknown) {
    const input = collectiveParticipationDeclarationSchema.parse(unsafeInput);
    return this.persistence.transaction((state) => {
      const connection = requireConnection(state, endpointCredential, input.connectionId);
      assertConnectionCoordinates(state, connection, input);
      requireAuthorizedHuman(state, connection);
      const current = state.participations[input.connectionId];
      if (current && current.revision >= input.revision) {
        if (current.revision === input.revision && JSON.stringify(current.agents) === JSON.stringify(input.agents))
          return structuredClone(current);
        throw new CollectiveServiceError(
          'PARTICIPATION_REVISION_CONFLICT',
          'Participation revision cannot be replayed or replaced',
          409,
        );
      }
      const record = { ...input, publishedAt: new Date(this.now()).toISOString() };
      state.participations[input.connectionId] = record;
      return structuredClone(record);
    });
  }

  readDeclaration(endpointCredential: string, unsafeInput: unknown) {
    const input = collectiveConnectionCoordinatesSchema.parse(unsafeInput);
    const state = this.persistence.snapshot();
    const connection = requireConnection(state, endpointCredential, input.connectionId);
    assertConnectionCoordinates(state, connection, input);
    requireAuthorizedHuman(state, connection);
    const declaration = state.participations[input.connectionId];
    return {
      declaration: declaration
        ? collectiveParticipationDeclarationSchema.parse(
            Object.fromEntries(Object.entries(declaration).filter(([key]) => key !== 'publishedAt')),
          )
        : null,
    };
  }

  list(sessionToken: string, collectiveId: string): CollectiveParticipant[] {
    const state = this.persistence.snapshot();
    const { human } = resolveSession(state, sessionToken);
    requireHumanAuthBinding(state, human.humanId);
    requireMembership(state, collectiveId, human.humanId);
    return Object.values(state.participations)
      .filter((declaration) => declaration.collectiveId === collectiveId)
      .flatMap((declaration) => {
        const connection = state.connections[declaration.connectionId];
        const owner = connection?.authorizedHumanId ? state.humans[connection.authorizedHumanId] : undefined;
        if (!connection || !owner) return [];
        const membership = state.memberships[`${collectiveId}:${owner.humanId}`];
        return declaration.agents.map((agent) => ({
          serviceInstanceId: state.serviceInstanceId,
          collectiveId,
          connectionId: connection.connectionId,
          endpointId: connection.endpointId,
          endpointLabel: connection.endpointLabel,
          humanId: owner.humanId,
          humanDisplayName: owner.displayName,
          ...agent,
          participationRevision: declaration.revision,
          availability: connection.status === 'connected' && membership ? ('declared' as const) : ('revoked' as const),
        }));
      });
  }

  readContext(endpointCredential: string, unsafeInput: unknown) {
    const input = contextRequest.parse(unsafeInput);
    const state = this.persistence.snapshot();
    const connection = requireConnection(state, endpointCredential, input.connectionId);
    assertConnectionCoordinates(state, connection, input);
    const owner = requireAuthorizedHuman(state, connection);
    const events = state.events[input.collectiveId] ?? [];
    const source = events.find((event) => event.eventId === input.eventId);
    if (!source?.location || !source.recipient)
      throw new CollectiveServiceError('RETURN_UNAVAILABLE', 'Public source is unavailable', 409);
    const sourceHuman = source.actor.kind === 'human' ? source.actor.humanId : source.actor.human.humanId;
    requireMembership(state, input.collectiveId, sourceHuman);
    requireHumanAuthBinding(state, sourceHuman);
    if (
      source.actor.kind === 'agent' &&
      state.connections[source.actor.provenance.connectionId]?.status !== 'connected'
    ) {
      throw new CollectiveServiceError('PARTICIPATION_REVOKED', 'The requesting Agent connection was revoked', 403);
    }
    const recipient = source.recipient;
    if (
      recipient.kind !== 'agent' ||
      recipient.connectionId !== connection.connectionId ||
      recipient.agentId !== input.catId ||
      recipient.participationRevision !== input.participationRevision ||
      recipient.humanId !== owner.humanId
    ) {
      throw new CollectiveServiceError('PARTICIPATION_REVOKED', 'Source does not authorize this participant', 403);
    }
    requireParticipant(state, { ...input, humanId: owner.humanId, channelId: source.location.channelId });
    const permitted = events.filter((event) => inSourceScope(event, source) && event.sequence > input.afterSequence);
    const page = permitted.slice(0, input.limit);
    return {
      source: structuredClone(source),
      events: structuredClone(page),
      ...(permitted.length > page.length ? { nextCursor: page.at(-1)?.sequence } : {}),
    };
  }
}

export function requireParticipant(
  state: ServiceState,
  input: {
    collectiveId: string;
    connectionId: string;
    catId: string;
    participationRevision: number;
    humanId: string;
    channelId: string;
  },
) {
  const connection = state.connections[input.connectionId];
  const declaration = state.participations[input.connectionId];
  const agent = declaration?.agents.find((candidate) => candidate.catId === input.catId);
  if (
    !connection ||
    connection.status !== 'connected' ||
    connection.collectiveId !== input.collectiveId ||
    connection.authorizedHumanId !== input.humanId ||
    declaration?.revision !== input.participationRevision ||
    !agent?.channelIds.includes(input.channelId)
  ) {
    throw new CollectiveServiceError('PARTICIPATION_REVOKED', 'Participant is unavailable for this public scope', 403);
  }
  requireMembership(state, input.collectiveId, input.humanId);
  return agent;
}

function inSourceScope(event: CollectiveEventEnvelope, source: CollectiveEventEnvelope): boolean {
  if (!event.location || !source.location || event.location.channelId !== source.location.channelId) return false;
  const root = source.location.rootEventId;
  return !root || event.eventId === root || event.location.rootEventId === root;
}
