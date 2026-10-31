import { createHash } from 'node:crypto';
import type { InteractionEvent, PersonClaimVersion, PersonIdentity, PersonRelationship } from '@cat-cafe/shared';

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => [key, canonicalize(child)]),
  );
}

function revision(kind: string, value: unknown): string {
  return `sha256:${createHash('sha256')
    .update(kind)
    .update('\0')
    .update(JSON.stringify(canonicalize(value)))
    .digest('hex')}`;
}

export function personClaimOwnerRevision(claim: PersonClaimVersion): string {
  return revision('f276-owner-claim-v1', claim);
}

export function personInteractionOwnerRevision(event: InteractionEvent): string {
  return revision('f276-owner-event-v1', event);
}

export function personAggregateOwnerRevision(input: {
  person: PersonIdentity;
  claims: readonly PersonClaimVersion[];
  relationships: readonly PersonRelationship[];
  events: readonly InteractionEvent[];
}): string {
  return revision('f276-owner-person-v1', {
    person: input.person,
    claims: [...input.claims].sort((left, right) => left.claimId.localeCompare(right.claimId)),
    relationships: [...input.relationships].sort((left, right) =>
      left.relationshipId.localeCompare(right.relationshipId),
    ),
    events: [...input.events].sort((left, right) => left.eventId.localeCompare(right.eventId)),
  });
}
