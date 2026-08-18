import {
  type InteractionEvent,
  PERSON_MEMORY_LIMITS,
  type PersonClaimVersion,
  type PersonIdentity,
  type PersonRelationship,
  personIdSchema,
  type RelationshipCard,
  relationshipCardSchema,
} from '@cat-cafe/shared';
import { estimateTokens } from '../../../utils/token-counter.js';
import type { PersonAliasResolution, PersonMemoryStore } from './PersonMemoryStore.js';
import type { WorkspacePersonResolver } from './WorkspacePersonResolver.js';

type RecallStore = Pick<
  PersonMemoryStore,
  | 'resolveActivePersonByAlias'
  | 'resolveActivePersonByWorkspaceEntityRef'
  | 'getPerson'
  | 'listClaims'
  | 'listRelationships'
  | 'listInteractionEvents'
>;

export type PersonMemoryRecallResult =
  | { status: 'resolved'; card: RelationshipCard; asOf: number }
  | { status: 'ambiguous'; candidates: Array<{ personId: string; displayName: string }> }
  | { status: 'not_available' };

export interface PersonMemoryDrillInput {
  ownerUserId: string;
  turnId: string;
  personId: string;
  item: {
    kind: 'claim' | 'relationship' | 'event';
    id: string;
  };
  timeWindow: {
    from: number;
    to: number;
  };
}

export type PersonMemoryDrillResult =
  | {
      status: 'ok';
      projection: {
        kind: PersonMemoryDrillInput['item']['kind'];
        itemId: string;
        text: string;
        sourceRef: { kind: 'message'; threadId: string; messageId: string };
      };
      estimatedTokens: number;
    }
  | { status: 'not_available' | 'budget_exceeded' };

interface TurnBudget {
  aggregateTokens: number;
  callsByPerson: Map<string, number>;
}

type VisibleClaim = PersonClaimVersion & {
  payload: Extract<PersonClaimVersion['payload'], { kind: 'reported_fact' | 'user_assessment' }>;
};

function isVisibleCurrentClaim(claim: PersonClaimVersion): claim is VisibleClaim {
  return claim.status === 'current' && claim.payload.kind !== 'redacted';
}

function claimText(claim: PersonClaimVersion): string {
  if (claim.payload.kind === 'user_assessment') return claim.payload.statement;
  if (claim.payload.kind === 'redacted') return '[redacted]';
  const rendered = typeof claim.payload.value === 'string' ? claim.payload.value : JSON.stringify(claim.payload.value);
  return `${claim.payload.predicate}: ${rendered}`;
}

function relationshipText(relationship: PersonRelationship): string {
  if (relationship.status === 'current') return '当前关系';
  if (relationship.status === 'former') return '曾有关系';
  return '关系状态未确认';
}

function eventText(event: InteractionEvent): string {
  return event.headline;
}

function latestActiveEvent(events: InteractionEvent[]): InteractionEvent | undefined {
  return events
    .filter((event) => event.status === 'active')
    .sort((left, right) => right.recordedAt - left.recordedAt)[0];
}

function relationshipCardAsOf(
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

function uniqueSourceRefs(
  refs: Array<{ kind: 'message'; threadId: string; messageId: string }>,
): Array<{ kind: 'message'; threadId: string; messageId: string }> {
  const unique = new Map<string, (typeof refs)[number]>();
  for (const ref of refs) unique.set(`${ref.threadId}\0${ref.messageId}`, ref);
  return [...unique.values()].slice(0, PERSON_MEMORY_LIMITS.maxProvenanceRefsPerCard);
}

function cardTokenEstimate(card: Omit<RelationshipCard, 'estimatedTokens'>): number {
  return estimateTokens(
    [
      card.displayName,
      ...card.facts.map((fact) => fact.text),
      card.relationshipLine ?? '',
      card.latestInteraction?.headline ?? '',
    ].join('\n'),
  );
}

function boundedRelationshipCard(input: {
  personId: RelationshipCard['personId'];
  displayName: string;
  relationship: PersonRelationship;
  claims: PersonClaimVersion[];
  events: InteractionEvent[];
}): RelationshipCard {
  const currentClaims = input.claims
    .filter(isVisibleCurrentClaim)
    .sort((left, right) => right.recordedAt - left.recordedAt)
    .slice(0, PERSON_MEMORY_LIMITS.maxFactsPerRelationshipCard);
  const latestEvent = latestActiveEvent(input.events);
  const provenanceRefs = uniqueSourceRefs([
    ...currentClaims.flatMap((claim) => claim.sourceRefs),
    ...input.relationship.sourceRefs,
    ...(latestEvent?.sourceRefs ?? []),
  ]);
  const base: Omit<RelationshipCard, 'estimatedTokens'> = {
    personId: input.personId,
    relationshipId: input.relationship.relationshipId,
    displayName: input.displayName,
    facts: currentClaims.map((claim) => ({
      claimId: claim.claimId,
      text: claimText(claim),
      kind: claim.payload.kind,
      provenanceRefs: claim.sourceRefs.slice(0, PERSON_MEMORY_LIMITS.maxProvenanceRefsPerCard),
    })),
    relationshipLine: relationshipText(input.relationship),
    ...(latestEvent
      ? {
          latestInteraction: {
            eventId: latestEvent.eventId,
            ...(latestEvent.occurredAt ? { occurredAt: latestEvent.occurredAt } : {}),
            headline: latestEvent.headline,
          },
        }
      : {}),
    uncertainty: [],
    provenanceRefs,
    dossierRef: input.personId,
    storable: false,
    indexable: false,
  };

  while (base.facts.length > 0 && cardTokenEstimate(base) > PERSON_MEMORY_LIMITS.maxRelationshipCardTokens) {
    base.facts.pop();
  }
  if (cardTokenEstimate(base) > PERSON_MEMORY_LIMITS.maxRelationshipCardTokens) {
    delete base.latestInteraction;
  }
  if (cardTokenEstimate(base) > PERSON_MEMORY_LIMITS.maxRelationshipCardTokens) {
    delete base.relationshipLine;
  }
  return relationshipCardSchema.parse({
    ...base,
    estimatedTokens: cardTokenEstimate(base),
  });
}

function boundedProjectionText(value: string): { text: string; estimatedTokens: number } {
  let text = value;
  let estimatedTokens = estimateTokens(text);
  while (estimatedTokens > PERSON_MEMORY_LIMITS.maxDrillTokensPerCall && text.length > 1) {
    text = `${text.slice(0, Math.max(1, Math.floor(text.length * 0.8)))}…`;
    estimatedTokens = estimateTokens(text);
  }
  return { text, estimatedTokens };
}

export class PersonMemoryRecallService {
  private readonly budgets = new Map<string, TurnBudget>();

  constructor(
    private readonly store: RecallStore,
    private readonly workspacePersonResolver: WorkspacePersonResolver,
  ) {}

  async recallByAlias(ownerUserId: string, alias: string): Promise<PersonMemoryRecallResult> {
    const resolution = await this.resolveConvergedPerson(ownerUserId, alias);
    if (resolution.status === 'not_available') return resolution;
    if (resolution.status === 'ambiguous') {
      return {
        status: 'ambiguous',
        candidates: resolution.people.map((person) => ({
          personId: person.personId,
          displayName: person.displayName,
        })),
      };
    }
    const person = resolution.person;
    return this.recallResolvedPerson(ownerUserId, person);
  }

  async recallByPersonId(ownerUserId: string, personId: string): Promise<PersonMemoryRecallResult> {
    const person = await this.store.getPerson(ownerUserId, personIdSchema.parse(personId));
    return person ? this.recallResolvedPerson(ownerUserId, person) : { status: 'not_available' };
  }

  async recallByWorkspaceEntityRef(ownerUserId: string, entityRef: string): Promise<PersonMemoryRecallResult> {
    const resolution = await this.store.resolveActivePersonByWorkspaceEntityRef(ownerUserId, entityRef);
    return resolution.status === 'resolved'
      ? this.recallResolvedPerson(ownerUserId, resolution.person)
      : { status: 'not_available' };
  }

  private async recallResolvedPerson(ownerUserId: string, person: PersonIdentity): Promise<PersonMemoryRecallResult> {
    if (person.ownerUserId !== ownerUserId || person.status !== 'active') return { status: 'not_available' };
    const [claims, relationships, events] = await Promise.all([
      this.store.listClaims(ownerUserId, person.personId),
      this.store.listRelationships(ownerUserId, person.personId),
      this.store.listInteractionEvents(ownerUserId, person.personId),
    ]);
    const relationship = relationships[relationships.length - 1];
    if (!relationship) return { status: 'not_available' };
    return {
      status: 'resolved',
      asOf: relationshipCardAsOf(person, claims, relationships, events),
      card: boundedRelationshipCard({
        personId: person.personId,
        displayName: person.displayName,
        relationship,
        claims,
        events,
      }),
    };
  }

  private async resolveConvergedPerson(ownerUserId: string, alias: string): Promise<PersonAliasResolution> {
    const workspace = await this.workspacePersonResolver.resolve(alias);
    if (workspace.status === 'ambiguous' || workspace.status === 'unavailable') {
      return { status: 'not_available' };
    }
    const privateAlias = await this.store.resolveActivePersonByAlias(ownerUserId, alias);
    if (workspace.status === 'not_found') return privateAlias;

    const workspaceExtension = await this.store.resolveActivePersonByWorkspaceEntityRef(
      ownerUserId,
      workspace.entityRef,
    );
    if (workspaceExtension.status !== 'resolved') return { status: 'not_available' };
    if (privateAlias.status === 'ambiguous') return { status: 'not_available' };
    if (privateAlias.status === 'resolved' && privateAlias.person.personId !== workspaceExtension.person.personId) {
      return { status: 'not_available' };
    }
    return workspaceExtension;
  }

  async drill(input: PersonMemoryDrillInput): Promise<PersonMemoryDrillResult> {
    if (
      !Number.isFinite(input.timeWindow.from) ||
      !Number.isFinite(input.timeWindow.to) ||
      input.timeWindow.from > input.timeWindow.to
    ) {
      return { status: 'not_available' };
    }
    const personId = personIdSchema.parse(input.personId);
    const person = await this.store.getPerson(input.ownerUserId, personId);
    if (!person || person.status !== 'active') return { status: 'not_available' };
    const item = await this.findItem(input);
    if (!item) return { status: 'not_available' };
    if (item.recordedAt < input.timeWindow.from || item.recordedAt > input.timeWindow.to) {
      return { status: 'not_available' };
    }

    const turnKey = `${input.ownerUserId}\0${input.turnId}`;
    const budget = this.budgets.get(turnKey) ?? { aggregateTokens: 0, callsByPerson: new Map<string, number>() };
    const calls = budget.callsByPerson.get(input.personId) ?? 0;
    if (calls >= PERSON_MEMORY_LIMITS.maxDrillsPerPersonPerTurn) return { status: 'budget_exceeded' };
    const bounded = boundedProjectionText(item.text);
    if (budget.aggregateTokens + bounded.estimatedTokens > PERSON_MEMORY_LIMITS.maxPersonMemoryTokensPerTurn) {
      return { status: 'budget_exceeded' };
    }
    budget.callsByPerson.set(input.personId, calls + 1);
    budget.aggregateTokens += bounded.estimatedTokens;
    this.budgets.set(turnKey, budget);
    return {
      status: 'ok',
      projection: {
        kind: input.item.kind,
        itemId: input.item.id,
        text: bounded.text,
        sourceRef: item.sourceRef,
      },
      estimatedTokens: bounded.estimatedTokens,
    };
  }

  clearPerson(ownerUserId: string, personId: string): void {
    for (const [key, budget] of this.budgets) {
      if (!key.startsWith(`${ownerUserId}\0`)) continue;
      budget.callsByPerson.delete(personId);
      if (budget.callsByPerson.size === 0) this.budgets.delete(key);
    }
  }

  private async findItem(input: PersonMemoryDrillInput): Promise<{
    recordedAt: number;
    text: string;
    sourceRef: { kind: 'message'; threadId: string; messageId: string };
  } | null> {
    if (input.item.kind === 'claim') {
      const claim = (await this.store.listClaims(input.ownerUserId, personIdSchema.parse(input.personId))).find(
        (candidate) => candidate.claimId === input.item.id && candidate.status !== 'redacted',
      );
      const sourceRef = claim?.sourceRefs[0];
      return claim && sourceRef ? { recordedAt: claim.recordedAt, text: claimText(claim), sourceRef } : null;
    }
    if (input.item.kind === 'relationship') {
      const relationship = (
        await this.store.listRelationships(input.ownerUserId, personIdSchema.parse(input.personId))
      ).find((candidate) => candidate.relationshipId === input.item.id);
      const sourceRef = relationship?.sourceRefs[0];
      return relationship && sourceRef
        ? {
            recordedAt: relationship.transitions.at(-1)?.recordedAt ?? relationship.createdAt,
            text: relationshipText(relationship),
            sourceRef,
          }
        : null;
    }
    const event = (
      await this.store.listInteractionEvents(input.ownerUserId, personIdSchema.parse(input.personId))
    ).find((candidate) => candidate.eventId === input.item.id && candidate.status !== 'redacted');
    const sourceRef = event?.sourceRefs[0];
    return event && sourceRef ? { recordedAt: event.recordedAt, text: eventText(event), sourceRef } : null;
  }
}
