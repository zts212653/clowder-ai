import type {
  CandidateClaimDraftId,
  MaterializationAuthority,
  PersonClaimVersion,
  PersonIdentity,
  PersonRelationship,
} from '@cat-cafe/shared';
import type { RedisClient } from '@cat-cafe/shared/utils';
import type {
  PersonMemoryDecisionReceipt,
  PersonMemoryUndoReceipt,
  PersonMemoryUndoResult,
  StoredPersonMemoryCandidate,
  UndoPersonMemoryDecisionInput,
} from './PersonMemoryStore.js';
import { normalizePrivateAlias, PersonMemoryKeys } from './person-memory-keys.js';
import { UNDO_DECISION_LUA } from './person-memory-lua.js';
import {
  parseClaim,
  parseEvent,
  parsePerson,
  parseRelationship,
  parseStoredCandidate,
} from './person-memory-records.js';
import { PersonMemoryRedisPlan } from './person-memory-redis-plan.js';

function authorityMatches(authority: MaterializationAuthority, receipt: PersonMemoryDecisionReceipt): boolean {
  return (
    authority.kind === 'card_approval' &&
    authority.candidateId === receipt.candidateId &&
    receipt.selectedDraftIds.includes(authority.draftId) &&
    authority.authorizedAt === receipt.decidedAt
  );
}

function currentClaimKey(owner: string, claim: PersonClaimVersion): string | null {
  if (claim.payload.kind === 'redacted' || claim.materializedBy.kind !== 'card_approval') return null;
  const predicate =
    claim.payload.kind === 'reported_fact' ? claim.payload.predicate : `assessment:${claim.materializedBy.draftId}`;
  return PersonMemoryKeys.currentClaim(owner, claim.personId, predicate);
}

function allCandidateDraftIds(candidate: StoredPersonMemoryCandidate): CandidateClaimDraftId[] {
  return [
    ...candidate.claimDrafts.map((draft) => draft.draftId),
    ...(candidate.relationshipDraft ? [candidate.relationshipDraft.draftId] : []),
    ...(candidate.interactionDraft ? [candidate.interactionDraft.draftId] : []),
  ];
}

function candidateAfterUndo(
  candidate: StoredPersonMemoryCandidate,
  receipt: PersonMemoryDecisionReceipt,
  undoReceipt: PersonMemoryUndoReceipt,
): StoredPersonMemoryCandidate {
  const selected = new Set<string>(receipt.selectedDraftIds);
  const approvedDraftIds = (candidate.approval?.approvedDraftIds ?? []).filter((draftId) => !selected.has(draftId));
  const {
    latestDecisionId: _latestDecisionId,
    latestDecisionReceipt: _latestDecisionReceipt,
    latestUndoReceipt: _latestUndoReceipt,
    materializedPersonId: _materializedPersonId,
    ...base
  } = candidate;
  if (candidate.state === 'materialized') {
    return {
      ...base,
      state: 'withdrawn',
      approval:
        approvedDraftIds.length > 0
          ? { approvedDraftIds, authorizedAt: candidate.approval?.authorizedAt ?? receipt.decidedAt }
          : undefined,
      latestUndoReceipt: undoReceipt,
    };
  }
  const draftOrder = allCandidateDraftIds(candidate);
  const remainingDraftIds = draftOrder.filter(
    (draftId) => candidate.remainingDraftIds.includes(draftId) || selected.has(draftId),
  );
  const state = approvedDraftIds.length > 0 ? 'partially_materialized' : 'pending_approval';
  return {
    ...base,
    state,
    remainingDraftIds,
    claimDrafts: candidate.claimDrafts.map((draft) =>
      selected.has(draft.draftId) ? { ...draft, decision: 'pending' } : draft,
    ),
    relationshipDraft:
      candidate.relationshipDraft && selected.has(candidate.relationshipDraft.draftId)
        ? { ...candidate.relationshipDraft, decision: 'pending' }
        : candidate.relationshipDraft,
    interactionDraft:
      candidate.interactionDraft && selected.has(candidate.interactionDraft.draftId)
        ? { ...candidate.interactionDraft, decision: 'pending' }
        : candidate.interactionDraft,
    approval:
      approvedDraftIds.length > 0
        ? { approvedDraftIds, authorizedAt: candidate.approval?.authorizedAt ?? receipt.decidedAt }
        : undefined,
    latestUndoReceipt: undoReceipt,
  };
}

function parseUndoResult(raw: unknown): PersonMemoryUndoResult {
  const result = String(raw);
  if (result === 'CONFLICT') return { outcome: 'conflict' };
  if (result === 'NOT_AVAILABLE') return { outcome: 'not_available' };
  if (result.startsWith('APPLIED:')) {
    return { outcome: 'applied', receipt: JSON.parse(result.slice('APPLIED:'.length)) };
  }
  if (result.startsWith('REPLAYED:')) {
    return { outcome: 'replayed', receipt: JSON.parse(result.slice('REPLAYED:'.length)) };
  }
  throw new Error(`unexpected F276 undo result: ${result}`);
}

function relationshipBeforeLastTransition(relationship: PersonRelationship): PersonRelationship | null {
  if (relationship.transitions.length <= 1) return null;
  const transitions = relationship.transitions.slice(0, -1);
  const previous = transitions.at(-1);
  if (!previous) return null;
  return {
    ...relationship,
    status: previous.status,
    materializedBy: previous.materializedBy,
    sourceRefs: previous.sourceRefs,
    transitions,
  };
}

async function planClaimUndo(
  redis: RedisClient,
  plan: PersonMemoryRedisPlan,
  owner: string,
  receipt: PersonMemoryDecisionReceipt,
): Promise<boolean> {
  for (const claimId of receipt.materializedClaimIds) {
    const claimKey = PersonMemoryKeys.claim(owner, claimId);
    const raw = await redis.get(claimKey);
    const claim = parseClaim(raw);
    if (!raw || !claim || claim.status !== 'current' || !authorityMatches(claim.materializedBy, receipt)) {
      return false;
    }
    const pointerKey = currentClaimKey(owner, claim);
    if (!pointerKey || (await redis.get(pointerKey)) !== claim.claimId) return false;
    plan.expect(claimKey, raw);
    plan.expect(pointerKey, claim.claimId);
    if (claim.supersedesClaimId) {
      const previousKey = PersonMemoryKeys.claim(owner, claim.supersedesClaimId);
      const previousRaw = await redis.get(previousKey);
      const previous = parseClaim(previousRaw);
      if (!previousRaw || !previous || previous.status !== 'superseded') return false;
      plan.expect(previousKey, previousRaw);
      plan.set(previousKey, JSON.stringify({ ...previous, status: 'current' }));
      plan.set(pointerKey, previous.claimId);
    } else {
      plan.del(pointerKey, 'string');
    }
    plan.del(claimKey, 'string');
    plan.zrem(PersonMemoryKeys.personClaims(owner, receipt.personId), claim.claimId);
  }
  return true;
}

async function planEventUndo(
  redis: RedisClient,
  plan: PersonMemoryRedisPlan,
  owner: string,
  receipt: PersonMemoryDecisionReceipt,
): Promise<boolean> {
  for (const eventId of receipt.materializedEventIds) {
    const eventKey = PersonMemoryKeys.event(owner, eventId);
    const raw = await redis.get(eventKey);
    const event = parseEvent(raw);
    if (!raw || !event || event.status !== 'active' || !authorityMatches(event.materializedBy, receipt)) {
      return false;
    }
    plan.expect(eventKey, raw);
    plan.del(eventKey, 'string');
    plan.zrem(PersonMemoryKeys.personEvents(owner, receipt.personId), event.eventId);
    plan.zrem(PersonMemoryKeys.relationshipEvents(owner, event.relationshipId), event.eventId);
  }
  return true;
}

async function planRelationshipUndo(
  redis: RedisClient,
  plan: PersonMemoryRedisPlan,
  owner: string,
  receipt: PersonMemoryDecisionReceipt,
): Promise<boolean> {
  for (const relationshipId of receipt.materializedRelationshipIds) {
    const relationshipKey = PersonMemoryKeys.relationship(owner, relationshipId);
    const raw = await redis.get(relationshipKey);
    const relationship = parseRelationship(raw);
    const latest = relationship?.transitions.at(-1);
    if (!raw || !relationship || !latest || !authorityMatches(latest.materializedBy, receipt)) {
      return false;
    }
    plan.expect(relationshipKey, raw);
    const restored = relationshipBeforeLastTransition(relationship);
    if (restored) {
      plan.set(relationshipKey, JSON.stringify(restored));
      continue;
    }
    const relationshipEventKey = PersonMemoryKeys.relationshipEvents(owner, relationshipId);
    const relationshipEventIds = await redis.zrange(relationshipEventKey, 0, -1);
    const remainingEventIds = relationshipEventIds.filter((eventId) => !receipt.materializedEventIds.includes(eventId));
    if (remainingEventIds.length > 0) return false;
    plan.expectZRange(relationshipEventKey, relationshipEventIds);
    plan.del(relationshipKey, 'string');
    plan.del(relationshipEventKey, 'zset');
    plan.zrem(PersonMemoryKeys.personRelationships(owner, receipt.personId), relationshipId);
    plan.expect(PersonMemoryKeys.primaryRelationship(owner, receipt.personId), relationshipId);
    plan.del(PersonMemoryKeys.primaryRelationship(owner, receipt.personId), 'string');
  }
  return true;
}

async function planPersonRemoval(
  redis: RedisClient,
  plan: PersonMemoryRedisPlan,
  owner: string,
  person: PersonIdentity,
  receipt: PersonMemoryDecisionReceipt,
): Promise<number | null> {
  const claimIndex = PersonMemoryKeys.personClaims(owner, person.personId);
  const relationshipIndex = PersonMemoryKeys.personRelationships(owner, person.personId);
  const eventIndex = PersonMemoryKeys.personEvents(owner, person.personId);
  const [claimIds, relationshipIds, eventIds] = await Promise.all([
    redis.zrange(claimIndex, 0, -1),
    redis.zrange(relationshipIndex, 0, -1),
    redis.zrange(eventIndex, 0, -1),
  ]);
  plan.expectZRange(claimIndex, claimIds);
  plan.expectZRange(relationshipIndex, relationshipIds);
  plan.expectZRange(eventIndex, eventIds);
  const remaining =
    claimIds.filter((id) => !receipt.materializedClaimIds.includes(id)).length +
    relationshipIds.filter((id) => !receipt.materializedRelationshipIds.includes(id)).length +
    eventIds.filter((id) => !receipt.materializedEventIds.includes(id)).length;
  if (remaining > 0 || !authorityMatches(person.materializedBy, receipt)) return 0;

  const personKey = PersonMemoryKeys.person(owner, person.personId);
  const rawPerson = await redis.get(personKey);
  if (!rawPerson) return null;
  plan.expect(personKey, rawPerson);
  plan.del(personKey, 'string');
  plan.del(claimIndex, 'zset');
  plan.del(relationshipIndex, 'zset');
  plan.del(eventIndex, 'zset');
  for (const alias of person.privateAliases) {
    plan.srem(PersonMemoryKeys.alias(owner, normalizePrivateAlias(alias)), person.personId);
  }
  if (person.workspaceEntityLink) {
    const reverseKey = PersonMemoryKeys.workspaceEntityPerson(owner, person.workspaceEntityLink.entityRef);
    if ((await redis.get(reverseKey)) === person.personId) {
      plan.expect(reverseKey, person.personId);
      plan.del(reverseKey, 'string');
    }
  }
  return 1;
}

export async function undoPersonMemoryDecision(
  redis: RedisClient,
  input: UndoPersonMemoryDecisionInput,
): Promise<PersonMemoryUndoResult> {
  const owner = input.ownerUserId;
  const candidateKey = PersonMemoryKeys.candidate(owner, input.candidateId);
  const decisionKey = PersonMemoryKeys.decision(owner, input.candidateId, input.decisionId);
  const undoKey = PersonMemoryKeys.undo(owner, input.candidateId, input.requestId);
  const prior = await redis.get(undoKey);
  if (prior) return { outcome: 'replayed', receipt: JSON.parse(prior) as PersonMemoryUndoReceipt };

  const [candidateRaw, decisionRaw] = await Promise.all([redis.get(candidateKey), redis.get(decisionKey)]);
  const candidate = parseStoredCandidate(candidateRaw);
  const decision = decisionRaw ? (JSON.parse(decisionRaw) as PersonMemoryDecisionReceipt) : null;
  if (!candidateRaw || !candidate || !decisionRaw || !decision || candidate.latestDecisionId !== input.decisionId) {
    return { outcome: 'not_available' };
  }
  const personRaw = await redis.get(PersonMemoryKeys.person(owner, decision.personId));
  const person = parsePerson(personRaw);
  if (!personRaw || !person) return { outcome: 'not_available' };

  const pendingKey = PersonMemoryKeys.pending(owner);
  const fenceKey = PersonMemoryKeys.forgetFence(owner, decision.personId);
  const plan = new PersonMemoryRedisPlan([candidateKey, decisionKey, undoKey, pendingKey, fenceKey]);
  plan.fence(fenceKey);
  plan.expect(candidateKey, candidateRaw);
  plan.expect(decisionKey, decisionRaw);
  if (
    !(await planClaimUndo(redis, plan, owner, decision)) ||
    !(await planEventUndo(redis, plan, owner, decision)) ||
    !(await planRelationshipUndo(redis, plan, owner, decision))
  ) {
    return { outcome: 'conflict' };
  }
  const removedPerson = await planPersonRemoval(redis, plan, owner, person, decision);
  if (removedPerson === null) return { outcome: 'conflict' };
  const selectedDraftIds = new Set<string>(decision.selectedDraftIds);
  const candidateState =
    candidate.state === 'materialized'
      ? 'withdrawn'
      : (candidate.approval?.approvedDraftIds ?? []).some((draftId) => !selectedDraftIds.has(draftId))
        ? 'partially_materialized'
        : 'pending_approval';
  const undoReceipt: PersonMemoryUndoReceipt = {
    requestId: input.requestId,
    candidateId: input.candidateId,
    decisionId: input.decisionId,
    personId: decision.personId,
    candidateState,
    removed: {
      claims: decision.materializedClaimIds.length,
      relationships: decision.materializedRelationshipIds.length,
      events: decision.materializedEventIds.length,
      person: removedPerson,
    },
    verdict: 'undone',
    undoneAt: input.undoneAt,
  };
  const updatedCandidate = candidateAfterUndo(candidate, decision, undoReceipt);
  plan.set(candidateKey, JSON.stringify(updatedCandidate));
  plan.sadd(PersonMemoryKeys.personArtifacts(owner, decision.personId), undoKey);

  const raw = await redis.eval(
    UNDO_DECISION_LUA,
    plan.keys.length,
    ...plan.keys,
    input.candidateId,
    JSON.stringify(undoReceipt),
    plan.serialize(),
    candidateState === 'withdrawn' ? 'remove_pending' : 'keep_pending',
    String(input.undoneAt),
  );
  return parseUndoResult(raw);
}
