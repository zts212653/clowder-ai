import { isDeepStrictEqual } from 'node:util';
import type {
  CollectiveEventEnvelope,
  CollectiveLocation,
  CollectiveRecipient,
  CollectiveTarget,
} from '@cat-cafe/shared';

import { CollectiveServiceError } from './errors.js';
import { resolveEventAddress } from './event-location.js';
import { requireMembership } from './identity-store.js';
import { requireParticipant } from './participation-store.js';
import { createStableId } from './persistence.js';
import type { MutableServiceState } from './state.js';

export interface AppendEventInput {
  readonly coordinates: {
    readonly serviceInstanceId: string;
    readonly collectiveId: string;
    readonly clientEventId: string;
    readonly target?: CollectiveTarget;
    readonly location?: CollectiveLocation;
    readonly recipient?: CollectiveRecipient;
    readonly replyToEventId?: string;
    readonly workRequest?: 'entrust';
    readonly body: string;
  };
  readonly actorScope: string;
  readonly actor: CollectiveEventEnvelope['actor'];
  readonly now: number;
}

export function appendEvent(state: MutableServiceState, input: AppendEventInput): CollectiveEventEnvelope {
  const events = state.events[input.coordinates.collectiveId] ?? [];
  const address = resolveEventAddress(events, input.coordinates);
  if (input.coordinates.workRequest && (input.actor.kind !== 'human' || address.recipient.kind !== 'agent')) {
    throw new CollectiveServiceError(
      'PARTICIPATION_INVALID',
      'A sustained request requires a Human and an exact participant',
      422,
    );
  }
  if (address.recipient.kind === 'human')
    requireMembership(state, input.coordinates.collectiveId, address.recipient.humanId);
  if (address.recipient.kind === 'agent')
    requireParticipant(state, {
      ...input.coordinates,
      connectionId: address.recipient.connectionId,
      catId: address.recipient.agentId,
      participationRevision: address.recipient.participationRevision,
      channelId: address.location.channelId,
      humanId: address.recipient.humanId,
    });
  const indexKey = `${input.coordinates.collectiveId}:${input.actorScope}:${input.coordinates.clientEventId}`;
  const existingId = state.clientEventIndex[indexKey];
  const existing = existingId ? events.find((event) => event.eventId === existingId) : undefined;
  if (existing) {
    const matches =
      existing.body === input.coordinates.body &&
      existing.replyToEventId === input.coordinates.replyToEventId &&
      existing.workRequest === input.coordinates.workRequest &&
      isDeepStrictEqual(existing.location, address.location) &&
      isDeepStrictEqual(existing.recipient, address.recipient) &&
      isDeepStrictEqual(existing.actor, input.actor);
    if (!matches) {
      throw new CollectiveServiceError('CLIENT_EVENT_CONFLICT', 'clientEventId already names a different event', 409);
    }
    return structuredClone(existing) as CollectiveEventEnvelope;
  }
  const event: CollectiveEventEnvelope = {
    serviceInstanceId: state.serviceInstanceId,
    collectiveId: input.coordinates.collectiveId,
    eventId: createStableId('evt_'),
    clientEventId: input.coordinates.clientEventId,
    sequence: (events.at(-1)?.sequence ?? 0) + 1,
    actor: input.actor,
    ...address,
    ...(input.coordinates.replyToEventId ? { replyToEventId: input.coordinates.replyToEventId } : {}),
    ...(input.coordinates.workRequest ? { workRequest: input.coordinates.workRequest } : {}),
    body: input.coordinates.body,
    acceptedAt: new Date(input.now).toISOString(),
  };
  events.push(event);
  state.events[input.coordinates.collectiveId] = events;
  state.clientEventIndex[indexKey] = event.eventId;
  return structuredClone(event);
}
