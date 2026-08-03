import {
  type ApprovalEnvelope,
  type ApprovalPublication,
  type InteractionEvent,
  type PersonClaimVersion,
  type PersonIdentity,
  type PersonRelationship,
} from '@cat-cafe/shared';
import type { RedisClient } from '@cat-cafe/shared/utils';
import type { HumanDispositionRandomBytesSource } from '../../human-disposition/human-disposition-adapters.js';
import { PersonMemoryDispositionProofResolver } from './PersonMemoryDispositionProofResolver.js';
import type {
  AmendPersonInteractionInput,
  ApprovePersonMemoryDraftsInput,
  CorrectPersonClaimInput,
  HardForgetPersonInput,
  HardForgetPersonMemoryProposalInput,
  PersonAliasResolution,
  PersonMemoryAmendmentResult,
  PersonMemoryCorrectionResult,
  PersonMemoryDecisionReceipt,
  PersonMemoryDecisionResult,
  PersonMemoryRedactionResult,
  PersonMemoryRejectResult,
  PersonMemoryStore,
  PersonMemoryUndoResult,
  RedactPersonMemoryItemInput,
  RejectPersonMemoryCandidateInput,
  RetirePersonClaimInput,
  StagePersonMemoryCandidateInput,
  StoredPersonMemoryCandidate,
  UndoPersonMemoryDecisionInput,
} from './PersonMemoryStore.js';
import { approvePersonMemoryDrafts } from './person-memory-approval.js';
import { PersonMemoryCandidatePublication } from './person-memory-candidate-publication.js';
import {
  resolveDormantPersonCandidateBySubject,
  resolvePendingPersonCandidateBySubject,
} from './person-memory-candidate-registry.js';
import { PersonMemoryDispositionAnchor } from './person-memory-disposition-anchor.js';
import { PersonMemoryDispositionReject } from './person-memory-disposition-reject.js';
import { hardForgetPerson } from './person-memory-forget.js';
import { normalizePrivateAlias, PersonMemoryKeys } from './person-memory-keys.js';
import {
  amendPersonInteraction,
  correctPersonClaim,
  redactPersonMemoryItem,
  retirePersonClaim,
} from './person-memory-lifecycle.js';
import { UPDATE_CANDIDATE_STATE_LUA, WITHDRAW_CANDIDATE_LUA } from './person-memory-lua.js';
import { hardForgetPersonMemoryProposal } from './person-memory-proposal-forget.js';
import {
  parseClaim,
  parseEvent,
  parsePerson,
  parseRelationship,
  parseStoredCandidate,
} from './person-memory-records.js';
import { undoPersonMemoryDecision } from './person-memory-undo.js';

function terminalCandidate(
  candidate: StoredPersonMemoryCandidate,
  state: 'rejected' | 'withdrawn',
): StoredPersonMemoryCandidate {
  const {
    personDraft: _personDraft,
    relationshipDraft: _relationshipDraft,
    interactionDraft: _interactionDraft,
    sourceBundle: _sourceBundle,
    ...base
  } = candidate;
  return {
    ...base,
    state,
    claimDrafts: [],
    remainingDraftIds: [],
  };
}

function candidatePersonId(candidate: StoredPersonMemoryCandidate): string | undefined {
  return candidate.materializedPersonId ?? candidate.targetPersonId;
}

function candidateForgetFence(candidate: StoredPersonMemoryCandidate): string {
  const personId = candidatePersonId(candidate);
  return personId ? PersonMemoryKeys.forgetFence(candidate.ownerUserId, personId) : '';
}

export class RedisPersonMemoryStore implements PersonMemoryStore {
  private readonly dispositionResolver: PersonMemoryDispositionProofResolver;
  private readonly dispositionAnchor: PersonMemoryDispositionAnchor;
  private readonly dispositionReject: PersonMemoryDispositionReject;
  private readonly candidatePublication: PersonMemoryCandidatePublication;

  constructor(
    private readonly redis: RedisClient,
    options: { humanDispositionRandomBytesSource?: HumanDispositionRandomBytesSource } = {},
  ) {
    this.dispositionResolver = new PersonMemoryDispositionProofResolver(redis);
    this.dispositionAnchor = new PersonMemoryDispositionAnchor(
      redis,
      this.dispositionResolver,
      options.humanDispositionRandomBytesSource,
    );
    this.dispositionReject = new PersonMemoryDispositionReject(
      redis,
      this.dispositionResolver,
      options.humanDispositionRandomBytesSource,
    );
    this.candidatePublication = new PersonMemoryCandidatePublication(redis, this.dispositionAnchor);
  }

  stageCandidate(input: StagePersonMemoryCandidateInput): Promise<StoredPersonMemoryCandidate> {
    return this.candidatePublication.stage(input);
  }

  async getCandidateForOwner(ownerUserId: string, candidateId: string): Promise<StoredPersonMemoryCandidate | null> {
    return parseStoredCandidate(await this.redis.get(PersonMemoryKeys.candidate(ownerUserId, candidateId)));
  }

  async listPending(ownerUserId: string, limit = 100): Promise<StoredPersonMemoryCandidate[]> {
    const ids = await this.redis.zrevrange(PersonMemoryKeys.pending(ownerUserId), 0, Math.max(0, limit - 1));
    const candidates = await Promise.all(ids.map((id) => this.getCandidateForOwner(ownerUserId, id)));
    return candidates.filter(
      (candidate): candidate is StoredPersonMemoryCandidate =>
        candidate !== null &&
        candidate.publication.state === 'anchored' &&
        (candidate.state === 'pending_approval' ||
          candidate.state === 'not_now' ||
          candidate.state === 'partially_materialized'),
    );
  }

  async resolvePendingCandidateBySubject(
    ownerUserId: string,
    subject: string,
  ): Promise<StoredPersonMemoryCandidate | null> {
    return resolvePendingPersonCandidateBySubject(this.redis, ownerUserId, subject, (candidateId) =>
      this.getCandidateForOwner(ownerUserId, candidateId),
    );
  }

  resolveDormantCandidateBySubject(ownerUserId: string, subject: string) {
    return resolveDormantPersonCandidateBySubject(this.redis, ownerUserId, subject);
  }

  async getPublication(candidateId: string, ownerUserId?: string): Promise<ApprovalPublication | null> {
    const owner = ownerUserId ?? (await this.redis.get(PersonMemoryKeys.candidateOwner(candidateId)));
    if (!owner) return null;
    return (await this.getCandidateForOwner(owner, candidateId))?.publication ?? null;
  }

  commitEnvelope(candidateId: string, envelope: ApprovalEnvelope): Promise<void> {
    return this.candidatePublication.commit(candidateId, envelope);
  }

  abortStaged(candidateId: string, _reason: string): Promise<void> {
    return this.candidatePublication.abort(candidateId);
  }

  async approveDrafts(input: ApprovePersonMemoryDraftsInput): Promise<PersonMemoryDecisionResult> {
    const prior = await this.redis.get(
      PersonMemoryKeys.decision(input.ownerUserId, input.candidateId, input.decisionId),
    );
    if (prior) {
      return { outcome: 'replayed', receipt: JSON.parse(prior) as PersonMemoryDecisionReceipt };
    }
    const candidate = await this.getCandidateForOwner(input.ownerUserId, input.candidateId);
    if (!candidate) return { outcome: 'not_available' };
    return approvePersonMemoryDrafts(this.redis, candidate, input);
  }

  undoDecision(input: UndoPersonMemoryDecisionInput): Promise<PersonMemoryUndoResult> {
    return undoPersonMemoryDecision(this.redis, input);
  }

  async markNotNow(ownerUserId: string, candidateId: string, decidedAt: number): Promise<StoredPersonMemoryCandidate> {
    const candidate = await this.getCandidateForOwner(ownerUserId, candidateId);
    if (!candidate) throw new Error('candidate not available');
    const updated: StoredPersonMemoryCandidate = { ...candidate, state: 'not_now', notNowAt: decidedAt };
    const personId = candidatePersonId(candidate);
    const keys = [PersonMemoryKeys.candidate(ownerUserId, candidateId), PersonMemoryKeys.pending(ownerUserId)];
    if (personId) keys.push(candidateForgetFence(candidate));
    const result = String(
      await this.redis.eval(
        UPDATE_CANDIDATE_STATE_LUA,
        keys.length,
        ...keys,
        JSON.stringify(updated),
        'keep_pending',
        String(decidedAt),
        candidateId,
        '',
        String(personId ? 3 : 0),
        '0',
        '0',
        '0',
      ),
    );
    if (result !== 'UPDATED') throw new Error(`F276 not-now failed: ${result}`);
    return updated;
  }

  async rejectCandidate(input: RejectPersonMemoryCandidateInput): Promise<PersonMemoryRejectResult> {
    return this.dispositionReject.reject(input);
  }

  async withdrawCandidate(
    ownerUserId: string,
    candidateId: string,
    _decidedAt: number,
  ): Promise<StoredPersonMemoryCandidate> {
    const candidate = await this.getCandidateForOwner(ownerUserId, candidateId);
    if (!candidate) throw new Error('candidate not available');
    const updated = terminalCandidate(candidate, 'withdrawn');
    const keys = [
      PersonMemoryKeys.candidate(ownerUserId, candidateId),
      PersonMemoryKeys.pending(ownerUserId),
      candidateForgetFence(candidate),
    ];
    const result = String(
      await this.redis.eval(WITHDRAW_CANDIDATE_LUA, keys.length, ...keys, JSON.stringify(updated), candidateId),
    );
    if (result !== 'UPDATED') throw new Error(`F276 withdraw failed: ${result}`);
    return updated;
  }

  async getPerson(ownerUserId: string, personId: string): Promise<PersonIdentity | null> {
    return parsePerson(await this.redis.get(PersonMemoryKeys.person(ownerUserId, personId)));
  }

  async resolveActivePersonByAlias(ownerUserId: string, alias: string): Promise<PersonAliasResolution> {
    const ids = await this.redis.smembers(PersonMemoryKeys.alias(ownerUserId, normalizePrivateAlias(alias)));
    const people = (await Promise.all(ids.slice(0, 4).map((id) => this.getPerson(ownerUserId, id)))).filter(
      (person): person is PersonIdentity => person?.status === 'active',
    );
    if (people.length === 0) return { status: 'not_available' };
    if (people.length === 1) return { status: 'resolved', person: people[0] };
    return { status: 'ambiguous', people: people.slice(0, 3) };
  }

  async resolveActivePersonByWorkspaceEntityRef(
    ownerUserId: string,
    entityRef: string,
  ): Promise<PersonAliasResolution> {
    const personId = await this.redis.get(PersonMemoryKeys.workspaceEntityPerson(ownerUserId, entityRef));
    if (!personId) return { status: 'not_available' };
    const person = await this.getPerson(ownerUserId, personId);
    if (
      !person ||
      person.status !== 'active' ||
      person.workspaceEntityLink?.state !== 'linked' ||
      person.workspaceEntityLink.entityRef !== entityRef
    ) {
      return { status: 'not_available' };
    }
    return { status: 'resolved', person };
  }

  async listClaims(ownerUserId: string, personId: string): Promise<PersonClaimVersion[]> {
    return this.readSorted(PersonMemoryKeys.personClaims(ownerUserId, personId), (id) =>
      this.redis.get(PersonMemoryKeys.claim(ownerUserId, id)).then(parseClaim),
    );
  }

  async listRelationships(ownerUserId: string, personId: string): Promise<PersonRelationship[]> {
    return this.readSorted(PersonMemoryKeys.personRelationships(ownerUserId, personId), (id) =>
      this.redis.get(PersonMemoryKeys.relationship(ownerUserId, id)).then(parseRelationship),
    );
  }

  async listInteractionEvents(ownerUserId: string, personId: string): Promise<InteractionEvent[]> {
    return this.readSorted(PersonMemoryKeys.personEvents(ownerUserId, personId), (id) =>
      this.redis.get(PersonMemoryKeys.event(ownerUserId, id)).then(parseEvent),
    );
  }

  correctClaim(input: CorrectPersonClaimInput): Promise<PersonMemoryCorrectionResult> {
    return correctPersonClaim(this.redis, input);
  }

  retireClaim(input: RetirePersonClaimInput): Promise<PersonMemoryCorrectionResult> {
    return retirePersonClaim(this.redis, input);
  }

  amendInteractionEvent(input: AmendPersonInteractionInput): Promise<PersonMemoryAmendmentResult> {
    return amendPersonInteraction(this.redis, input);
  }

  redactItem(input: RedactPersonMemoryItemInput): Promise<PersonMemoryRedactionResult> {
    return redactPersonMemoryItem(this.redis, input);
  }

  hardForget(input: HardForgetPersonInput) {
    return hardForgetPerson(this.redis, input);
  }

  hardForgetProposal(input: HardForgetPersonMemoryProposalInput) {
    return hardForgetPersonMemoryProposal(this.redis, input);
  }

  private async readSorted<T>(sortedSetKey: string, read: (id: string) => Promise<T | null>): Promise<T[]> {
    const ids = await this.redis.zrange(sortedSetKey, 0, -1);
    const records: T[] = [];
    for (const id of ids) {
      const record = await read(id);
      if (record !== null) records.push(record);
    }
    return records;
  }
}
