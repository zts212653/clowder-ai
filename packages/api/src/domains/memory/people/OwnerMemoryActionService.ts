import type { InteractionEvent, PersonClaimVersion, PersonIdentity, PersonRelationship } from '@cat-cafe/shared';
import { OwnerMemoryActionEvidenceIssuer, ownerActionRequestDigest } from './OwnerMemoryActionEvidenceIssuer.js';
import {
  PersonMemoryOwnerSourceReader,
  type PersonMemoryOwnerSourceReaderDeps,
} from './PersonMemoryOwnerSourceReader.js';
import type { PersonMemoryStore } from './PersonMemoryStore.js';
import type {
  OwnerMemoryActionCommand,
  OwnerMemoryActionExecutionResult,
  OwnerMemoryActionStore,
} from './person-memory-owner-action-contract.js';
import {
  personAggregateOwnerRevision,
  personClaimOwnerRevision,
  personInteractionOwnerRevision,
} from './person-memory-owner-revision.js';

type OwnerActionReadStore = Pick<
  PersonMemoryStore,
  'getPerson' | 'listClaims' | 'listRelationships' | 'listInteractionEvents'
>;

export interface OwnerMemoryActionServiceDeps extends PersonMemoryOwnerSourceReaderDeps {
  store: OwnerActionReadStore & OwnerMemoryActionStore;
  issuer?: OwnerMemoryActionEvidenceIssuer;
  now?: () => number;
}

export interface OwnerBrowserActionContext {
  ownerUserId: string;
  sessionBindingId: string;
  csrfToken: string;
}

type OwnerActionTargetResult =
  | { status: 'ready'; sourceItem: PersonIdentity | PersonClaimVersion | InteractionEvent }
  | { status: 'not_available' | 'stale_revision' };

function ownedBy(item: { ownerUserId: string }, ownerUserId: string): boolean {
  return item.ownerUserId === ownerUserId;
}

function ownedPersonItem(
  item: { ownerUserId: string; personId: string },
  ownerUserId: string,
  personId: string,
): boolean {
  return item.ownerUserId === ownerUserId && item.personId === personId;
}

export class OwnerMemoryActionService {
  private readonly sourceReader: PersonMemoryOwnerSourceReader;
  private readonly issuer: OwnerMemoryActionEvidenceIssuer;
  private readonly now: () => number;

  constructor(private readonly deps: OwnerMemoryActionServiceDeps) {
    this.sourceReader = new PersonMemoryOwnerSourceReader({
      messageStore: deps.messageStore,
      threadStore: deps.threadStore,
      ...(deps.ownerPrivateArtifactResolver ? { ownerPrivateArtifactResolver: deps.ownerPrivateArtifactResolver } : {}),
    });
    this.issuer = deps.issuer ?? new OwnerMemoryActionEvidenceIssuer();
    this.now = deps.now ?? Date.now;
  }

  async execute(
    context: OwnerBrowserActionContext,
    command: OwnerMemoryActionCommand,
  ): Promise<OwnerMemoryActionExecutionResult> {
    const requestDigest = ownerActionRequestDigest(context.ownerUserId, command);
    const replay = await this.deps.store.resolveOwnerActionReplay({
      ownerUserId: context.ownerUserId,
      command,
      requestDigest,
    });
    if (replay.outcome === 'idempotency_conflict') {
      return { action: command.action, outcome: 'idempotency_conflict' };
    }
    if (replay.outcome === 'replayed') {
      return { ...replay.result, outcome: 'replayed' };
    }

    const target = await this.resolveTarget(context.ownerUserId, command);
    if (target.status !== 'ready') return { action: command.action, outcome: target.status };

    const source = await this.sourceReader.read(context.ownerUserId, target.sourceItem);
    const sourceState = source.status === 'ready' ? 'live' : 'unavailable_erasure_only';
    if (sourceState !== 'live' && command.action !== 'retire_claim' && command.action !== 'hard_forget_person') {
      return { action: command.action, outcome: 'source_unavailable' };
    }

    const evidence = this.issuer.issue({
      ownerUserId: context.ownerUserId,
      sessionBindingId: context.sessionBindingId,
      csrfToken: context.csrfToken,
      command,
      requestDigest,
      sourceState,
      issuedAt: this.now(),
    });
    return this.deps.store.executeOwnerAction({
      ownerUserId: context.ownerUserId,
      command,
      requestDigest,
      evidence,
    });
  }

  private async resolveTarget(
    ownerUserId: string,
    command: OwnerMemoryActionCommand,
  ): Promise<OwnerActionTargetResult> {
    const person = await this.deps.store.getPerson(ownerUserId, command.personId);
    if (!person || !ownedBy(person, ownerUserId) || person.personId !== command.personId) {
      return { status: 'not_available' };
    }
    if (command.action === 'correct_claim' || command.action === 'retire_claim') {
      return this.resolveClaimTarget(ownerUserId, command);
    }
    if (command.action === 'amend_event') {
      return this.resolveEventTarget(ownerUserId, command);
    }
    return this.resolvePersonTarget(ownerUserId, person, command);
  }

  private async resolveClaimTarget(
    ownerUserId: string,
    command: Extract<OwnerMemoryActionCommand, { action: 'correct_claim' | 'retire_claim' }>,
  ): Promise<OwnerActionTargetResult> {
    const claim = (await this.deps.store.listClaims(ownerUserId, command.personId)).find(
      (candidate) => candidate.claimId === command.claimId,
    );
    if (!claim || !ownedPersonItem(claim, ownerUserId, command.personId)) return { status: 'not_available' };
    if (personClaimOwnerRevision(claim) !== command.expectedRevision) return { status: 'stale_revision' };
    const correctable =
      command.action === 'correct_claim' && (claim.status === 'current' || claim.status === 'retired');
    const retireable = command.action === 'retire_claim' && claim.status === 'current';
    return correctable || retireable ? { status: 'ready', sourceItem: claim } : { status: 'not_available' };
  }

  private async resolveEventTarget(
    ownerUserId: string,
    command: Extract<OwnerMemoryActionCommand, { action: 'amend_event' }>,
  ): Promise<OwnerActionTargetResult> {
    const event = (await this.deps.store.listInteractionEvents(ownerUserId, command.personId)).find(
      (candidate) => candidate.eventId === command.eventId,
    );
    if (!event || !ownedBy(event, ownerUserId)) return { status: 'not_available' };
    if (personInteractionOwnerRevision(event) !== command.expectedRevision) return { status: 'stale_revision' };
    if (event.status !== 'active') return { status: 'not_available' };
    const relationship = (await this.deps.store.listRelationships(ownerUserId, command.personId)).find(
      (candidate) => candidate.relationshipId === event.relationshipId,
    );
    if (!relationship || !ownedPersonItem(relationship, ownerUserId, command.personId)) {
      return { status: 'not_available' };
    }
    return { status: 'ready', sourceItem: event };
  }

  private async resolvePersonTarget(
    ownerUserId: string,
    person: PersonIdentity,
    command: Extract<OwnerMemoryActionCommand, { action: 'hard_forget_person' }>,
  ): Promise<OwnerActionTargetResult> {
    const [claims, relationships, events] = await Promise.all([
      this.deps.store.listClaims(ownerUserId, command.personId),
      this.deps.store.listRelationships(ownerUserId, command.personId),
      this.deps.store.listInteractionEvents(ownerUserId, command.personId),
    ]);
    if (!this.validAggregateOwnership(ownerUserId, command.personId, claims, relationships, events)) {
      return { status: 'not_available' };
    }
    if (personAggregateOwnerRevision({ person, claims, relationships, events }) !== command.expectedPersonRevision) {
      return { status: 'stale_revision' };
    }
    return { status: 'ready', sourceItem: person };
  }

  private validAggregateOwnership(
    ownerUserId: string,
    personId: string,
    claims: readonly PersonClaimVersion[],
    relationships: readonly PersonRelationship[],
    events: readonly InteractionEvent[],
  ): boolean {
    if (claims.some((item) => !ownedPersonItem(item, ownerUserId, personId))) return false;
    if (relationships.some((item) => !ownedPersonItem(item, ownerUserId, personId))) return false;
    const relationshipIds = new Set(relationships.map((item) => item.relationshipId));
    return events.every((item) => ownedBy(item, ownerUserId) && relationshipIds.has(item.relationshipId));
  }
}
