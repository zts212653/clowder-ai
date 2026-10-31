import type {
  InteractionEvent,
  PersonClaimVersion,
  PersonIdentity,
  PersonMemorySourceRef,
  PersonRelationship,
} from '@cat-cafe/shared';
import {
  type PersonMemoryOwnerSourceItem,
  PersonMemoryOwnerSourceReader,
  type PersonMemoryOwnerSourceReaderDeps,
} from './PersonMemoryOwnerSourceReader.js';
import type { PersonMemoryStore } from './PersonMemoryStore.js';
import { readPersonMemoryProposals } from './person-memory-owner-proposals.js';
import {
  personAggregateOwnerRevision,
  personClaimOwnerRevision,
  personInteractionOwnerRevision,
} from './person-memory-owner-revision.js';

const MAX_DETAIL_ITEMS = 200;

type OwnerReadStore = Pick<
  PersonMemoryStore,
  | 'listPeople'
  | 'getPerson'
  | 'listClaims'
  | 'listRelationships'
  | 'listInteractionEvents'
  | 'listCandidateIdsForPerson'
  | 'getCandidateForOwner'
>;

export interface PersonMemoryOwnerReadDeps extends PersonMemoryOwnerSourceReaderDeps {
  store: OwnerReadStore;
}

export interface PersonMemorySourceSelector {
  kind: 'person' | 'claim' | 'relationship' | 'event';
  itemId?: string;
}

function sourceCount(item: {
  sourceRefs: readonly PersonMemorySourceRef[];
  materializedBy?: { kind: string };
}): number {
  if (item.materializedBy?.kind === 'owner_memory_action') return 1;
  return new Set(item.sourceRefs.map((ref) => `${ref.threadId}\0${ref.messageId}`)).size;
}

function relationshipRecordedAt(relationship: PersonRelationship): number {
  return relationship.transitions.at(-1)?.recordedAt ?? relationship.createdAt;
}

function latestRelationship(relationships: readonly PersonRelationship[]): PersonRelationship | null {
  return (
    [...relationships].sort((left, right) => relationshipRecordedAt(right) - relationshipRecordedAt(left))[0] ?? null
  );
}

function latestInteraction(events: readonly InteractionEvent[]): InteractionEvent | null {
  return (
    [...events]
      .filter((event) => event.status === 'active')
      .sort((left, right) => right.recordedAt - left.recordedAt)[0] ?? null
  );
}

function personUpdatedAt(
  person: PersonIdentity,
  claims: readonly PersonClaimVersion[],
  relationships: readonly PersonRelationship[],
  events: readonly InteractionEvent[],
): number {
  return Math.max(
    person.createdAt,
    ...claims.map((claim) => claim.recordedAt),
    ...relationships.flatMap((relationship) => [
      relationship.createdAt,
      ...relationship.transitions.map((transition) => transition.recordedAt),
    ]),
    ...events.map((event) => event.recordedAt),
  );
}

function belongsToOwner(
  item: { ownerUserId: string; personId: string },
  ownerUserId: string,
  personId: string,
): boolean {
  return item.ownerUserId === ownerUserId && item.personId === personId;
}

export class PersonMemoryOwnerReadService {
  private readonly sourceReader: PersonMemoryOwnerSourceReader;

  constructor(private readonly deps: PersonMemoryOwnerReadDeps) {
    this.sourceReader = new PersonMemoryOwnerSourceReader({
      messageStore: deps.messageStore,
      threadStore: deps.threadStore,
      ...(deps.ownerPrivateArtifactResolver ? { ownerPrivateArtifactResolver: deps.ownerPrivateArtifactResolver } : {}),
    });
  }

  async list(ownerUserId: string, page: { limit: number; offset: number }) {
    const people = (await this.deps.store.listPeople(ownerUserId))
      .filter((person) => person.ownerUserId === ownerUserId)
      .sort((left, right) => right.createdAt - left.createdAt || left.personId.localeCompare(right.personId));
    const selected = people.slice(page.offset, page.offset + page.limit);
    const entries = await Promise.all(selected.map((person) => this.listEntry(ownerUserId, person)));
    const hasMore = page.offset + entries.length < people.length;
    return {
      readStatus: 'ready' as const,
      entries,
      meta: {
        count: entries.length,
        limit: page.limit,
        offset: page.offset,
        hasMore,
        ...(hasMore ? { nextOffset: page.offset + entries.length } : {}),
      },
    };
  }

  async readDetail(ownerUserId: string, personId: PersonIdentity['personId']) {
    const loaded = await this.loadOwnedPerson(ownerUserId, personId);
    if (!loaded) return { status: 'not_available' as const };
    const { person, claims, relationships, events } = loaded;
    const proposalProjection = await readPersonMemoryProposals(this.deps.store, ownerUserId, person, MAX_DETAIL_ITEMS);
    return {
      status: 'ready' as const,
      detail: {
        personId: person.personId,
        personRevision: personAggregateOwnerRevision({ person, claims, relationships, events }),
        displayName: person.displayName,
        aliases: person.privateAliases,
        status: person.status,
        createdAt: person.createdAt,
        updatedAt: personUpdatedAt(person, claims, relationships, events),
        sourceCount: sourceCount(person),
        ...(person.workspaceEntityLink
          ? {
              workspaceEntity: {
                state: person.workspaceEntityLink.state,
                checkedAt: person.workspaceEntityLink.checkedAt,
              },
            }
          : {}),
        claims: [...claims]
          .sort((left, right) => right.recordedAt - left.recordedAt)
          .slice(0, MAX_DETAIL_ITEMS)
          .map((claim) => ({
            claimId: claim.claimId,
            revision: personClaimOwnerRevision(claim),
            payload: claim.payload,
            status: claim.status,
            recordedAt: claim.recordedAt,
            ...(claim.validFrom !== undefined ? { validFrom: claim.validFrom } : {}),
            ...(claim.validTo !== undefined ? { validTo: claim.validTo } : {}),
            ...(claim.supersedesClaimId ? { supersedesClaimId: claim.supersedesClaimId } : {}),
            sourceCount: sourceCount(claim),
          })),
        relationships: [...relationships]
          .sort((left, right) => relationshipRecordedAt(right) - relationshipRecordedAt(left))
          .slice(0, MAX_DETAIL_ITEMS)
          .map((relationship) => ({
            relationshipId: relationship.relationshipId,
            status: relationship.status,
            createdAt: relationship.createdAt,
            sourceCount: sourceCount(relationship),
            transitions: relationship.transitions.slice(-MAX_DETAIL_ITEMS).map((transition) => ({
              status: transition.status,
              recordedAt: transition.recordedAt,
              sourceCount: sourceCount(transition),
            })),
          })),
        interactions: [...events]
          .sort((left, right) => right.recordedAt - left.recordedAt)
          .slice(0, MAX_DETAIL_ITEMS)
          .map((event) => ({
            eventId: event.eventId,
            revision: personInteractionOwnerRevision(event),
            relationshipId: event.relationshipId,
            eventKind: event.eventKind,
            headline: event.headline,
            status: event.status,
            recordedAt: event.recordedAt,
            ...(event.occurredAt ? { occurredAt: event.occurredAt } : {}),
            ...(event.duration ? { duration: event.duration } : {}),
            ...(event.importanceOrTopic ? { importanceOrTopic: event.importanceOrTopic } : {}),
            ...(event.uncertaintyNotes ? { uncertaintyNotes: event.uncertaintyNotes } : {}),
            ...(event.amendsEventId ? { amendsEventId: event.amendsEventId } : {}),
            sourceCount: sourceCount(event),
          })),
        proposals: proposalProjection.proposals,
        truncation: {
          claims: claims.length > MAX_DETAIL_ITEMS,
          relationships: relationships.length > MAX_DETAIL_ITEMS,
          interactions: events.length > MAX_DETAIL_ITEMS,
          proposals: proposalProjection.truncated,
        },
      },
    };
  }

  async readSource(ownerUserId: string, personId: PersonIdentity['personId'], selector: PersonMemorySourceSelector) {
    const person = await this.deps.store.getPerson(ownerUserId, personId);
    if (!person || person.ownerUserId !== ownerUserId || person.personId !== personId) {
      return { status: 'not_available' as const };
    }
    const item = await this.sourceItem(ownerUserId, person, selector);
    if (item.status !== 'ready') return item;
    return this.sourceReader.read(ownerUserId, item.value);
  }

  private async listEntry(ownerUserId: string, person: PersonIdentity) {
    const [claims, relationships, events] = await Promise.all([
      this.deps.store.listClaims(ownerUserId, person.personId),
      this.deps.store.listRelationships(ownerUserId, person.personId),
      this.deps.store.listInteractionEvents(ownerUserId, person.personId),
    ]);
    const ownedClaims = claims.filter((claim) => belongsToOwner(claim, ownerUserId, person.personId));
    const ownedRelationships = relationships.filter((item) => belongsToOwner(item, ownerUserId, person.personId));
    const relationshipIds = new Set(ownedRelationships.map((item) => item.relationshipId));
    const ownedEvents = events.filter(
      (item) => item.ownerUserId === ownerUserId && relationshipIds.has(item.relationshipId),
    );
    const relationship = latestRelationship(ownedRelationships);
    const interaction = latestInteraction(ownedEvents);
    return {
      personId: person.personId,
      displayName: person.displayName,
      aliases: person.privateAliases,
      status: person.status,
      createdAt: person.createdAt,
      updatedAt: personUpdatedAt(person, ownedClaims, ownedRelationships, ownedEvents),
      currentClaimCount: ownedClaims.filter((claim) => claim.status === 'current').length,
      activeInteractionCount: ownedEvents.filter((event) => event.status === 'active').length,
      relationship: relationship
        ? {
            relationshipId: relationship.relationshipId,
            status: relationship.status,
            recordedAt: relationshipRecordedAt(relationship),
          }
        : null,
      latestInteraction: interaction
        ? {
            eventId: interaction.eventId,
            eventKind: interaction.eventKind,
            headline: interaction.headline,
            ...(interaction.occurredAt ? { occurredAt: interaction.occurredAt } : {}),
            recordedAt: interaction.recordedAt,
          }
        : null,
    };
  }

  private async loadOwnedPerson(ownerUserId: string, personId: PersonIdentity['personId']) {
    const person = await this.deps.store.getPerson(ownerUserId, personId);
    if (!person || person.ownerUserId !== ownerUserId || person.personId !== personId) return null;
    const [claims, relationships, events] = await Promise.all([
      this.deps.store.listClaims(ownerUserId, person.personId),
      this.deps.store.listRelationships(ownerUserId, person.personId),
      this.deps.store.listInteractionEvents(ownerUserId, person.personId),
    ]);
    if (
      claims.some((item) => !belongsToOwner(item, ownerUserId, personId)) ||
      relationships.some((item) => !belongsToOwner(item, ownerUserId, personId)) ||
      events.some(
        (item) =>
          item.ownerUserId !== ownerUserId ||
          !relationships.some((relationship) => relationship.relationshipId === item.relationshipId),
      )
    ) {
      return null;
    }
    return { person, claims, relationships, events };
  }

  private async sourceItem(
    ownerUserId: string,
    person: PersonIdentity,
    selector: PersonMemorySourceSelector,
  ): Promise<{ status: 'ready'; value: PersonMemoryOwnerSourceItem } | { status: 'not_available' | 'unavailable' }> {
    if (selector.kind === 'person') return { status: 'ready', value: person };
    if (!selector.itemId) return { status: 'not_available' };
    if (selector.kind === 'claim') return this.claimSourceItem(ownerUserId, person, selector.itemId);
    if (selector.kind === 'event') return this.eventSourceItem(ownerUserId, person, selector.itemId);
    return this.relationshipSourceItem(ownerUserId, person, selector.itemId);
  }

  private async claimSourceItem(ownerUserId: string, person: PersonIdentity, itemId: string) {
    const claim = (await this.deps.store.listClaims(ownerUserId, person.personId)).find(
      (item) => item.claimId === itemId,
    );
    if (!claim || !belongsToOwner(claim, ownerUserId, person.personId)) return { status: 'not_available' as const };
    return claim.status === 'redacted'
      ? { status: 'unavailable' as const }
      : { status: 'ready' as const, value: claim };
  }

  private async eventSourceItem(ownerUserId: string, person: PersonIdentity, itemId: string) {
    const event = (await this.deps.store.listInteractionEvents(ownerUserId, person.personId)).find(
      (item) => item.eventId === itemId,
    );
    if (!event || event.ownerUserId !== ownerUserId) return { status: 'not_available' as const };
    const relationship = (await this.deps.store.listRelationships(ownerUserId, person.personId)).find(
      (item) => item.relationshipId === event.relationshipId,
    );
    if (!relationship || !belongsToOwner(relationship, ownerUserId, person.personId)) {
      return { status: 'not_available' as const };
    }
    return event.status === 'redacted'
      ? { status: 'unavailable' as const }
      : { status: 'ready' as const, value: event };
  }

  private async relationshipSourceItem(ownerUserId: string, person: PersonIdentity, itemId: string) {
    const relationship = (await this.deps.store.listRelationships(ownerUserId, person.personId)).find(
      (item) => item.relationshipId === itemId,
    );
    if (!relationship || !belongsToOwner(relationship, ownerUserId, person.personId)) {
      return { status: 'not_available' as const };
    }
    const current = relationship.transitions.at(-1);
    return {
      status: 'ready' as const,
      value: current
        ? {
            ownerUserId,
            sourceRefs: current.sourceRefs,
            typedProvenance: current.typedProvenance,
            materializedBy: current.materializedBy,
          }
        : relationship,
    };
  }
}
