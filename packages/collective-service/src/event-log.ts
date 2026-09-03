import type { CollectiveEventEnvelope, CollectiveTarget } from '@cat-cafe/shared';

import { CollectiveServiceError } from './errors.js';
import { createStableId } from './persistence.js';
import type { MutableServiceState } from './state.js';

export interface AppendEventInput {
  readonly coordinates: {
    readonly serviceInstanceId: string;
    readonly collectiveId: string;
    readonly clientEventId: string;
    readonly target: CollectiveTarget;
    readonly replyToEventId?: string;
    readonly body: string;
  };
  readonly actorScope: string;
  readonly actor: CollectiveEventEnvelope['actor'];
  readonly now: number;
}

export function appendEvent(state: MutableServiceState, input: AppendEventInput): CollectiveEventEnvelope {
  const events = state.events[input.coordinates.collectiveId] ?? [];
  validateMessageTarget(events, input.coordinates.target, input.coordinates.replyToEventId);
  const indexKey = `${input.coordinates.collectiveId}:${input.actorScope}:${input.coordinates.clientEventId}`;
  const existingId = state.clientEventIndex[indexKey];
  const existing = existingId ? events.find((event) => event.eventId === existingId) : undefined;
  if (existing) {
    const matches =
      existing.body === input.coordinates.body &&
      existing.replyToEventId === input.coordinates.replyToEventId &&
      JSON.stringify(existing.target) === JSON.stringify(input.coordinates.target);
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
    target: input.coordinates.target,
    ...(input.coordinates.replyToEventId ? { replyToEventId: input.coordinates.replyToEventId } : {}),
    body: input.coordinates.body,
    acceptedAt: new Date(input.now).toISOString(),
  };
  events.push(event);
  state.events[input.coordinates.collectiveId] = events;
  state.clientEventIndex[indexKey] = event.eventId;
  return structuredClone(event);
}

function validateMessageTarget(
  events: CollectiveEventEnvelope[],
  target: CollectiveTarget,
  replyToEventId?: string,
): void {
  const referencedIds = [replyToEventId, target.kind === 'message' ? target.eventId : undefined].filter(
    (value): value is string => value !== undefined,
  );
  if (referencedIds.some((eventId) => !events.some((event) => event.eventId === eventId))) {
    throw new CollectiveServiceError('COORDINATE_MISMATCH', 'Message target is outside Collective', 409);
  }
}
