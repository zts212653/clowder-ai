import {
  type CandidateClaimDraft,
  type CandidateClaimDraftId,
  type CandidateInteractionDraft,
  type CandidateRelationshipDraft,
  type CaptureCandidateId,
  type MaterializationAuthority,
  type PersonClaimId,
  type PersonClaimVersion,
  type PersonIdentity,
  type PersonRelationship,
  personIdSchema,
  personRelationshipIdSchema,
  type WorkspaceEntityLink,
} from '@cat-cafe/shared';
import type { RedisClient } from '@cat-cafe/shared/utils';
import { DeferredPersonMemoryReceiptKeys } from '../deferred-person-memory-redis-contract.js';
import type {
  ApprovePersonMemoryDraftsInput,
  PersonMemoryDecisionReceipt,
  PersonMemoryDecisionResult,
  StoredPersonMemoryCandidate,
} from './PersonMemoryStore.js';
import { parsePersonMemoryDecisionResult, updatePersonMemoryCandidate } from './person-memory-candidate.js';
import { normalizePrivateAlias, PersonMemoryKeys } from './person-memory-keys.js';
import { APPROVE_DRAFTS_LUA } from './person-memory-lua.js';
import { projectPersonMemorySourceRefs, selectPersonMemoryTypedProvenance } from './person-memory-provenance.js';
import {
  claimIdForDraft,
  eventIdForDraft,
  parseClaim,
  parsePerson,
  parseRelationship,
  personIdForCandidate,
  relationshipIdForPerson,
} from './person-memory-records.js';
import { PersonMemoryRedisPlan } from './person-memory-redis-plan.js';

type SelectableDraft = CandidateClaimDraft | CandidateRelationshipDraft | CandidateInteractionDraft;

function allDrafts(candidate: StoredPersonMemoryCandidate): SelectableDraft[] {
  return [
    ...candidate.claimDrafts,
    ...(candidate.relationshipDraft ? [candidate.relationshipDraft] : []),
    ...(candidate.interactionDraft ? [candidate.interactionDraft] : []),
  ];
}

function cardAuthority(
  candidateId: CaptureCandidateId,
  draftId: CandidateClaimDraftId,
  authorizedAt: number,
): MaterializationAuthority {
  return { kind: 'card_approval', candidateId, draftId, authorizedAt };
}

function addArtifact(plan: PersonMemoryRedisPlan, artifactSetKey: string, artifactKey: string): void {
  plan.sadd(artifactSetKey, artifactKey);
}

function selectedAuthorityDraft(
  relationshipDraft: CandidateRelationshipDraft | null,
  interactionDraft: CandidateInteractionDraft | null,
): CandidateRelationshipDraft | CandidateInteractionDraft {
  const draft = relationshipDraft ?? interactionDraft;
  if (!draft) throw new Error('F276 relationship planning requires a selected draft');
  return draft;
}

function workspaceLinksMatch(
  existingPerson: PersonIdentity | null,
  incoming: WorkspaceEntityLink | undefined,
): boolean {
  if (incoming && incoming.state !== 'linked') return false;
  if (!existingPerson) return true;
  const existing = existingPerson.workspaceEntityLink;
  if (!existing && !incoming) return true;
  return existing?.state === 'linked' && incoming?.state === 'linked' && existing.entityRef === incoming.entityRef;
}

async function reserveWorkspaceEntityLink(
  redis: RedisClient,
  plan: PersonMemoryRedisPlan,
  artifactSet: string,
  ownerUserId: string,
  personId: PersonIdentity['personId'],
  link: WorkspaceEntityLink | undefined,
): Promise<boolean> {
  if (!link) return true;
  const reverseKey = PersonMemoryKeys.workspaceEntityPerson(ownerUserId, link.entityRef);
  const currentPersonId = await redis.get(reverseKey);
  if (currentPersonId && currentPersonId !== personId) return false;
  plan.expect(reverseKey, currentPersonId ?? '');
  plan.set(reverseKey, personId);
  addArtifact(plan, artifactSet, reverseKey);
  return true;
}

async function resolvePerson(
  redis: RedisClient,
  plan: PersonMemoryRedisPlan,
  candidate: StoredPersonMemoryCandidate,
  selectedDrafts: SelectableDraft[],
  authorizedAt: number,
): Promise<PersonIdentity | null> {
  const selectedDraft = selectedDrafts[0];
  if (!selectedDraft) return null;
  const owner = candidate.ownerUserId;
  const mappedPersonId =
    candidate.materializedPersonId ??
    candidate.targetPersonId ??
    personIdSchema.nullable().parse(await redis.get(PersonMemoryKeys.candidatePerson(owner, candidate.candidateId)));
  const personId = mappedPersonId ?? personIdForCandidate(candidate.candidateId);
  const personKey = PersonMemoryKeys.person(owner, personId);
  const existing = parsePerson(await redis.get(personKey));
  if (candidate.targetPersonId && !existing) return null;

  const artifactSet = PersonMemoryKeys.personArtifacts(owner, personId);
  plan.fence(PersonMemoryKeys.forgetFence(owner, personId));
  plan.set(PersonMemoryKeys.candidatePerson(owner, candidate.candidateId), personId);
  plan.sadd(PersonMemoryKeys.personCandidates(owner, personId), candidate.candidateId);
  addArtifact(plan, artifactSet, PersonMemoryKeys.candidate(owner, candidate.candidateId));
  addArtifact(plan, artifactSet, PersonMemoryKeys.candidateOwner(candidate.candidateId));
  addArtifact(plan, artifactSet, PersonMemoryKeys.candidatePerson(owner, candidate.candidateId));
  addArtifact(plan, artifactSet, PersonMemoryKeys.personCandidates(owner, personId));
  if (candidate.deltaFingerprint) {
    addArtifact(plan, artifactSet, DeferredPersonMemoryReceiptKeys.dedupe(owner, candidate.deltaFingerprint));
  }

  const personDraft = candidate.personDraft;
  if (!personDraft) return null;
  const incomingLink = personDraft.workspaceEntityLink;
  if (!workspaceLinksMatch(existing, incomingLink)) return null;
  if (!(await reserveWorkspaceEntityLink(redis, plan, artifactSet, owner, personId, incomingLink))) return null;

  if (existing) return existing;
  const typedProvenance = selectPersonMemoryTypedProvenance(
    candidate,
    selectedDrafts.map((draft) => draft.draftId),
  );
  const person: PersonIdentity = {
    personId,
    ownerUserId: owner,
    displayName: personDraft.displayName,
    privateAliases: personDraft.privateAliases,
    ...(personDraft.workspaceEntityLink ? { workspaceEntityLink: personDraft.workspaceEntityLink } : {}),
    status: 'active',
    materializedBy: cardAuthority(candidate.candidateId, selectedDraft.draftId, authorizedAt),
    createdAt: authorizedAt,
    sourceRefs: projectPersonMemorySourceRefs(typedProvenance, candidate.sourceMessageRef),
    ...(typedProvenance ? { typedProvenance } : {}),
  };
  plan.set(personKey, JSON.stringify(person));
  addArtifact(plan, artifactSet, personKey);
  for (const alias of person.privateAliases) {
    const aliasKey = PersonMemoryKeys.alias(owner, normalizePrivateAlias(alias));
    plan.sadd(aliasKey, personId);
  }
  return person;
}

async function planClaims(
  redis: RedisClient,
  plan: PersonMemoryRedisPlan,
  candidate: StoredPersonMemoryCandidate,
  person: PersonIdentity,
  selectedIds: Set<string>,
  authorizedAt: number,
): Promise<string[] | null> {
  const createdIds: string[] = [];
  const artifactSet = PersonMemoryKeys.personArtifacts(candidate.ownerUserId, person.personId);
  for (const draft of candidate.claimDrafts) {
    if (!selectedIds.has(draft.draftId)) continue;
    const claimId = claimIdForDraft(candidate.candidateId, draft.draftId);
    const claimKey = PersonMemoryKeys.claim(candidate.ownerUserId, claimId);
    const predicate = draft.payload.kind === 'reported_fact' ? draft.payload.predicate : `assessment:${draft.draftId}`;
    const currentKey = PersonMemoryKeys.currentClaim(candidate.ownerUserId, person.personId, predicate);
    const currentId = await redis.get(currentKey);
    plan.expect(currentKey, currentId ?? '');

    let supersedesClaimId: PersonClaimId | undefined;
    if (currentId) {
      const previousKey = PersonMemoryKeys.claim(candidate.ownerUserId, currentId);
      const previous = parseClaim(await redis.get(previousKey));
      if (!previous) return null;
      supersedesClaimId = previous.claimId;
      plan.set(previousKey, JSON.stringify({ ...previous, status: 'superseded' }));
      addArtifact(plan, artifactSet, previousKey);
    }

    const typedProvenance = selectPersonMemoryTypedProvenance(candidate, [draft.draftId]);
    const claim: PersonClaimVersion = {
      claimId,
      personId: person.personId,
      ownerUserId: candidate.ownerUserId,
      payload: draft.payload,
      status: 'current',
      recordedAt: authorizedAt,
      sourceRefs: projectPersonMemorySourceRefs(typedProvenance, candidate.sourceMessageRef),
      ...(typedProvenance ? { typedProvenance } : {}),
      materializedBy: cardAuthority(candidate.candidateId, draft.draftId, authorizedAt),
      ...(supersedesClaimId ? { supersedesClaimId } : {}),
    };
    plan.set(claimKey, JSON.stringify(claim));
    plan.set(currentKey, claimId);
    plan.zadd(PersonMemoryKeys.personClaims(candidate.ownerUserId, person.personId), authorizedAt, claimId);
    addArtifact(plan, artifactSet, claimKey);
    addArtifact(plan, artifactSet, currentKey);
    addArtifact(plan, artifactSet, PersonMemoryKeys.personClaims(candidate.ownerUserId, person.personId));
    createdIds.push(claimId);
  }
  return createdIds;
}

function materializeRelationship(
  existing: PersonRelationship | null,
  relationshipDraft: CandidateRelationshipDraft | null,
  transition: PersonRelationship['transitions'][number],
  relationshipId: PersonRelationship['relationshipId'],
  ownerUserId: string,
  personId: PersonIdentity['personId'],
  authorizedAt: number,
): PersonRelationship {
  if (!existing) {
    return {
      relationshipId,
      ownerUserId,
      personId,
      status: transition.status,
      materializedBy: transition.materializedBy,
      createdAt: authorizedAt,
      sourceRefs: transition.sourceRefs,
      ...(transition.typedProvenance ? { typedProvenance: transition.typedProvenance } : {}),
      transitions: [transition],
    };
  }
  if (!relationshipDraft || relationshipDraft.payload.status === existing.status) return existing;
  return {
    ...existing,
    status: relationshipDraft.payload.status,
    materializedBy: transition.materializedBy,
    sourceRefs: transition.sourceRefs,
    ...(transition.typedProvenance ? { typedProvenance: transition.typedProvenance } : { typedProvenance: undefined }),
    transitions: [...existing.transitions, transition],
  };
}

async function planRelationshipAndEvent(
  redis: RedisClient,
  plan: PersonMemoryRedisPlan,
  candidate: StoredPersonMemoryCandidate,
  person: PersonIdentity,
  selectedIds: Set<string>,
  selectedDrafts: SelectableDraft[],
  authorizedAt: number,
): Promise<{ relationshipIds: string[]; eventIds: string[] }> {
  const relationshipDraft =
    candidate.relationshipDraft && selectedIds.has(candidate.relationshipDraft.draftId)
      ? candidate.relationshipDraft
      : null;
  const interactionDraft =
    candidate.interactionDraft && selectedIds.has(candidate.interactionDraft.draftId)
      ? candidate.interactionDraft
      : null;
  const owner = candidate.ownerUserId;
  const primaryKey = PersonMemoryKeys.primaryRelationship(owner, person.personId);
  const existingId = await redis.get(primaryKey);
  plan.expect(primaryKey, existingId ?? '');
  const relationshipId = existingId
    ? personRelationshipIdSchema.parse(existingId)
    : relationshipIdForPerson(person.personId);
  const relationshipKey = PersonMemoryKeys.relationship(owner, relationshipId);
  const existing = parseRelationship(await redis.get(relationshipKey));
  const authorityDraft =
    relationshipDraft ?? interactionDraft ?? selectedDrafts[0] ?? selectedAuthorityDraft(null, null);
  const typedProvenance = selectPersonMemoryTypedProvenance(candidate, [authorityDraft.draftId]);
  const transition: PersonRelationship['transitions'][number] = {
    status: relationshipDraft?.payload.status ?? existing?.status ?? 'unknown',
    recordedAt: authorizedAt,
    materializedBy: cardAuthority(candidate.candidateId, authorityDraft.draftId, authorizedAt),
    sourceRefs: projectPersonMemorySourceRefs(typedProvenance, candidate.sourceMessageRef),
    ...(typedProvenance ? { typedProvenance } : {}),
  };

  const relationship = materializeRelationship(
    existing,
    relationshipDraft,
    transition,
    relationshipId,
    owner,
    person.personId,
    authorizedAt,
  );
  const artifactSet = PersonMemoryKeys.personArtifacts(owner, person.personId);
  plan.set(relationshipKey, JSON.stringify(relationship));
  plan.set(primaryKey, relationshipId);
  plan.zadd(PersonMemoryKeys.personRelationships(owner, person.personId), authorizedAt, relationshipId);
  addArtifact(plan, artifactSet, relationshipKey);
  addArtifact(plan, artifactSet, primaryKey);
  addArtifact(plan, artifactSet, PersonMemoryKeys.personRelationships(owner, person.personId));

  const eventIds = interactionDraft
    ? [planInteractionEvent(plan, candidate, interactionDraft, person, relationshipId, authorizedAt)]
    : [];
  return {
    relationshipIds: !existing || relationshipDraft ? [relationshipId] : [],
    eventIds,
  };
}

function planInteractionEvent(
  plan: PersonMemoryRedisPlan,
  candidate: StoredPersonMemoryCandidate,
  draft: CandidateInteractionDraft,
  person: PersonIdentity,
  relationshipId: PersonRelationship['relationshipId'],
  authorizedAt: number,
) {
  const owner = candidate.ownerUserId;
  const eventId = eventIdForDraft(candidate.candidateId, draft.draftId);
  const eventKey = PersonMemoryKeys.event(owner, eventId);
  const typedProvenance = selectPersonMemoryTypedProvenance(candidate, [draft.draftId]);
  const event = {
    eventId,
    relationshipId,
    ownerUserId: owner,
    ...draft.payload,
    recordedAt: authorizedAt,
    sourceRefs: projectPersonMemorySourceRefs(typedProvenance, candidate.sourceMessageRef),
    ...(typedProvenance ? { typedProvenance } : {}),
    materializedBy: cardAuthority(candidate.candidateId, draft.draftId, authorizedAt),
    status: 'active' as const,
  };
  const artifactSet = PersonMemoryKeys.personArtifacts(owner, person.personId);
  plan.set(eventKey, JSON.stringify(event));
  plan.zadd(PersonMemoryKeys.personEvents(owner, person.personId), authorizedAt, eventId);
  plan.zadd(PersonMemoryKeys.relationshipEvents(owner, relationshipId), authorizedAt, eventId);
  addArtifact(plan, artifactSet, eventKey);
  addArtifact(plan, artifactSet, PersonMemoryKeys.personEvents(owner, person.personId));
  addArtifact(plan, artifactSet, PersonMemoryKeys.relationshipEvents(owner, relationshipId));
  return eventId;
}

export async function approvePersonMemoryDrafts(
  redis: RedisClient,
  candidate: StoredPersonMemoryCandidate,
  input: ApprovePersonMemoryDraftsInput,
): Promise<PersonMemoryDecisionResult> {
  const selectedIds = new Set<CandidateClaimDraftId>(input.selectedDraftIds);
  if (selectedIds.size !== input.selectedDraftIds.length || selectedIds.size === 0) {
    return { outcome: 'conflict' };
  }
  const drafts = allDrafts(candidate);
  const selectedDrafts = drafts.filter((draft) => selectedIds.has(draft.draftId));
  if (selectedDrafts.length !== selectedIds.size) return { outcome: 'conflict' };

  const owner = input.ownerUserId;
  const candidateKey = PersonMemoryKeys.candidate(owner, input.candidateId);
  const pendingKey = PersonMemoryKeys.pending(owner);
  const decisionKey = PersonMemoryKeys.decision(owner, input.candidateId, input.decisionId);
  const plan = new PersonMemoryRedisPlan([candidateKey, pendingKey, decisionKey]);
  const person = await resolvePerson(redis, plan, candidate, selectedDrafts, input.authorizedAt);
  if (!person) return { outcome: 'not_available' };

  const materializedClaimIds = await planClaims(redis, plan, candidate, person, selectedIds, input.authorizedAt);
  if (!materializedClaimIds) return { outcome: 'not_available' };
  const { relationshipIds, eventIds } = await planRelationshipAndEvent(
    redis,
    plan,
    candidate,
    person,
    selectedIds,
    selectedDrafts,
    input.authorizedAt,
  );
  const updatedBase = updatePersonMemoryCandidate(candidate, selectedIds, person.personId, input.authorizedAt);
  const receipt: PersonMemoryDecisionReceipt = {
    decisionId: input.decisionId,
    candidateId: input.candidateId,
    state: updatedBase.state as PersonMemoryDecisionReceipt['state'],
    personId: person.personId,
    selectedDraftIds: input.selectedDraftIds,
    materializedClaimIds,
    materializedRelationshipIds: relationshipIds,
    materializedEventIds: eventIds,
    remainingDraftIds: updatedBase.remainingDraftIds,
    decidedAt: input.authorizedAt,
  };
  const updated: StoredPersonMemoryCandidate = {
    ...updatedBase,
    latestDecisionId: input.decisionId,
    latestDecisionReceipt: receipt,
    latestUndoReceipt: undefined,
  };
  const artifactSet = PersonMemoryKeys.personArtifacts(owner, person.personId);
  plan.sadd(artifactSet, decisionKey);

  const raw = await redis.eval(
    APPROVE_DRAFTS_LUA,
    plan.keys.length,
    ...plan.keys,
    JSON.stringify(input.selectedDraftIds),
    JSON.stringify(updated),
    JSON.stringify(receipt),
    updated.state,
    input.candidateId,
    plan.serialize(),
    String(candidate.createdAt),
  );
  return parsePersonMemoryDecisionResult(raw);
}
