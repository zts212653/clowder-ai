import {
  type InteractionEvent,
  type PersonClaimVersion,
  type PersonIdentity,
  type PersonRelationship,
  personIdSchema,
} from '@cat-cafe/shared';
import type { PersonMemoryOwnerSourceReader } from './PersonMemoryOwnerSourceReader.js';
import { boundedRelationshipCard } from './PersonMemoryRecallService.js';
import { personMemoryCardRevision } from './person-memory-card-revision.js';
export interface OwnerPersonSnapshot {
  person: PersonIdentity;
  claims: PersonClaimVersion[];
  relationships: PersonRelationship[];
  events: InteractionEvent[];
}
export function personDeliveryRevision(snapshot: OwnerPersonSnapshot): string | null {
  const { person, claims, relationships, events } = snapshot;
  const relationship = relationships.at(-1);
  if (person.status !== 'active' || !relationship) return null;
  return personMemoryCardRevision(
    boundedRelationshipCard({
      personId: person.personId,
      displayName: person.displayName,
      relationship,
      claims,
      events,
    }),
  );
}
export async function readPersonDelivery(
  owner: string,
  requestedId: string,
  revision: string,
  load: (owner: string, id: PersonIdentity['personId']) => Promise<OwnerPersonSnapshot | null>,
  sourceReader: PersonMemoryOwnerSourceReader,
) {
  const parsed = personIdSchema.safeParse(requestedId);
  if (!parsed.success) return { status: 'not_available' as const };
  const loaded = await load(owner, parsed.data);
  if (!loaded || loaded.person.status !== 'active') return { status: 'not_available' as const };
  const { person, claims, relationships, events } = loaded;
  const relationship = relationships.at(-1);
  if (!relationship) return { status: 'not_available' as const };
  const card = boundedRelationshipCard({
    personId: person.personId,
    displayName: person.displayName,
    relationship,
    claims,
    events,
  });
  if (personMemoryCardRevision(card) !== revision) return { status: 'version_changed' as const };
  const source = await sourceReader.read(owner, { ownerUserId: owner, sourceRefs: card.provenanceRefs });
  const first = source.status === 'ready' ? source.sources.find((item) => item.kind === 'message') : undefined;
  return {
    status: 'ready' as const,
    displayName: person.displayName,
    message: first?.kind === 'message' ? { threadId: first.threadId, messageId: first.messageId } : null,
  };
}
