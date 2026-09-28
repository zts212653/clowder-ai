import type {
  CollectiveEventEnvelope,
  CollectiveLocation,
  CollectiveRecipient,
  CollectiveTarget,
} from '@cat-cafe/shared';
import { CollectiveServiceError } from './errors.js';

interface AddressInput {
  target?: CollectiveTarget;
  location?: CollectiveLocation;
  recipient?: CollectiveRecipient;
  replyToEventId?: string;
}

/** The only compatibility resolver: location must be proven by a channel or an existing root. */
export function resolveEventAddress(events: readonly CollectiveEventEnvelope[], input: AddressInput) {
  const parentIds = [
    input.replyToEventId,
    input.target?.kind === 'message' ? input.target.eventId : undefined,
    input.location?.rootEventId,
  ].filter((id): id is string => Boolean(id));
  const parents = parentIds.map((id) => {
    const parent = events.find((event) => event.eventId === id);
    if (!parent) throw mismatch();
    const location = provenEventLocation(events, parent);
    if (!location) throw new CollectiveServiceError('LOCATION_REQUIRED', 'Legacy source has no proven location', 409);
    return { ...location, rootEventId: location.rootEventId ?? parent.eventId };
  });
  const channelId =
    input.location?.channelId ?? (input.target?.kind === 'channel' ? input.target.channelId : parents[0]?.channelId);
  if (!channelId)
    throw new CollectiveServiceError('LOCATION_REQUIRED', 'Public location is required for a directed message', 422);
  if (input.target?.kind === 'channel' && input.target.channelId !== channelId) throw mismatch();
  const rootEventId = input.location?.rootEventId ?? parents[0]?.rootEventId;
  if (parents.some((parent) => parent.channelId !== channelId || parent.rootEventId !== rootEventId)) throw mismatch();
  const location: CollectiveLocation = { channelId, ...(rootEventId ? { rootEventId } : {}) };
  const recipient = input.recipient ?? legacyRecipient(input.target);
  if (!recipient)
    throw new CollectiveServiceError('PARTICIPATION_REQUIRED', 'Select the exact declared participant', 422);
  const target: CollectiveTarget =
    recipient.kind === 'channel'
      ? rootEventId
        ? { kind: 'message', eventId: rootEventId }
        : { kind: 'channel', channelId }
      : recipient.kind === 'human'
        ? { kind: 'human', humanId: recipient.humanId }
        : { kind: 'agent', humanId: recipient.humanId, agentId: recipient.agentId };
  if (
    input.target?.kind === 'agent' &&
    (recipient.kind !== 'agent' ||
      recipient.humanId !== input.target.humanId ||
      recipient.agentId !== input.target.agentId)
  )
    throw mismatch();
  if (input.target?.kind === 'human' && (recipient.kind !== 'human' || recipient.humanId !== input.target.humanId))
    throw mismatch();
  return { location, recipient, target };
}

/** Legacy records remain readable. Unresolvable positions never become executable. */
export function provenEventLocation(
  events: readonly CollectiveEventEnvelope[],
  event: CollectiveEventEnvelope,
): CollectiveLocation | undefined {
  const seen = new Set<string>();
  let current: CollectiveEventEnvelope | undefined = event;
  let rootEventId: string | undefined;
  while (current && !seen.has(current.eventId)) {
    seen.add(current.eventId);
    if (current.location)
      return {
        ...current.location,
        ...(rootEventId ? { rootEventId: current.location.rootEventId ?? rootEventId } : {}),
      };
    const parentId: string | undefined =
      current.replyToEventId ?? (current.target.kind === 'message' ? current.target.eventId : undefined);
    if (!parentId && current.target.kind === 'channel')
      return { channelId: current.target.channelId, ...(rootEventId ? { rootEventId } : {}) };
    rootEventId = parentId;
    current = events.find((candidate) => candidate.eventId === parentId);
  }
  return undefined;
}

function legacyRecipient(target?: CollectiveTarget): CollectiveRecipient | undefined {
  if (target?.kind === 'human') return target;
  if (target?.kind === 'channel' || target?.kind === 'message') return { kind: 'channel' };
  return undefined;
}
function mismatch() {
  return new CollectiveServiceError('COORDINATE_MISMATCH', 'Reply location does not match its source', 409);
}
