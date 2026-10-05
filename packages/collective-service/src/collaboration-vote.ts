import type {
  CastCollectiveVoteRequest,
  CloseCollectiveVoteRequest,
  CollectiveVoteProjection,
  CollectiveVoteRecord,
  CreateCollectiveVoteRequest,
} from '@cat-cafe/shared';
import { requireWorkSource } from './collaboration-command-helpers.js';
import { collaborationOperationReplay, recordCollaborationOperation } from './collaboration-operations.js';
import { CollectiveServiceError } from './errors.js';
import { requireMembership } from './identity-store.js';
import { createStableId } from './persistence.js';
import type { MutableServiceState, ServiceState } from './state.js';

type Human = { readonly humanId: string; readonly displayName: string };

export function createCollectiveVote(
  state: MutableServiceState,
  input: CreateCollectiveVoteRequest,
  human: Human,
  now: number,
): CollectiveVoteProjection {
  const actorScope = `human:${human.humanId}`;
  const replay = collaborationOperationReplay(state, {
    ...input,
    actorScope,
    payload: input,
    resourceKind: 'vote',
  });
  if (replay.existing)
    return projectCollectiveVote(requireVote(state, input.collectiveId, replay.existing.resourceId), now);
  const source = requireWorkSource(state, input.collectiveId, input.sourceEventId);
  const closesAt = Date.parse(input.closesAt);
  if (!Number.isFinite(closesAt) || closesAt <= now || closesAt > now + 30 * 24 * 60 * 60 * 1_000) {
    throw new CollectiveServiceError(
      'VOTE_DEADLINE_INVALID',
      'Informal Vote deadline must be within the next 30 days',
      409,
    );
  }
  const labels = input.options.map((option) => option.trim());
  if (new Set(labels.map((label) => label.toLocaleLowerCase())).size !== labels.length) {
    throw new CollectiveServiceError('VOTE_OPTIONS_INVALID', 'Informal Vote options must be distinct', 409);
  }
  const at = new Date(now).toISOString();
  const voteId = createStableId('vote_');
  const actor = { humanId: human.humanId, displayName: human.displayName };
  const vote: CollectiveVoteRecord = {
    v: 1,
    serviceInstanceId: state.serviceInstanceId,
    collectiveId: input.collectiveId,
    voteId,
    sourceEventId: source.eventId,
    sourceLocation: source.location,
    kind: 'informal_poll',
    effect: 'preference_only',
    eligibility: 'current_members',
    ballotVisibility: 'named',
    question: input.question,
    options: labels.map((label) => ({ optionId: createStableId('vote_option_'), label })),
    ballots: [],
    createdBy: actor,
    closesAt: input.closesAt,
    lifecycle: 'open',
    revision: 1,
    createdAt: at,
    updatedAt: at,
    history: [{ revision: 1, action: 'created', actor, at }],
  };
  state.votes[voteId] = vote;
  recordVoteOperation(state, replay, actorScope, vote, at);
  return projectCollectiveVote(vote, now);
}

export function castCollectiveVote(
  state: MutableServiceState,
  input: CastCollectiveVoteRequest,
  human: Human,
  now: number,
): CollectiveVoteProjection {
  const actorScope = `human:${human.humanId}`;
  const replay = collaborationOperationReplay(state, {
    ...input,
    actorScope,
    payload: input,
    resourceKind: 'vote',
  });
  if (replay.existing)
    return projectCollectiveVote(requireVote(state, input.collectiveId, replay.existing.resourceId), now);
  const vote = mutableVote(state, input.collectiveId, input.voteId);
  if (projectCollectiveVote(vote, now).status !== 'open') {
    throw new CollectiveServiceError('VOTE_CLOSED', 'This informal Vote no longer accepts ballots', 409);
  }
  if (!vote.options.some((option) => option.optionId === input.optionId)) {
    throw new CollectiveServiceError('VOTE_OPTION_INVALID', 'Vote option was not found', 404);
  }
  const at = new Date(now).toISOString();
  const ballot = vote.ballots.find((candidate) => candidate.humanId === human.humanId);
  if (ballot?.optionId !== input.optionId) {
    vote.revision += 1;
    vote.updatedAt = at;
    if (ballot) {
      ballot.optionId = input.optionId;
      ballot.castAt = at;
    } else {
      vote.ballots.push({
        humanId: human.humanId,
        displayName: human.displayName,
        optionId: input.optionId,
        castAt: at,
      });
    }
    vote.history.push({
      revision: vote.revision,
      action: ballot ? 'ballot_changed' : 'ballot_cast',
      actor: { humanId: human.humanId, displayName: human.displayName },
      at,
      optionId: input.optionId,
    });
  }
  recordVoteOperation(state, replay, actorScope, vote, at);
  return projectCollectiveVote(vote, now);
}

export function closeCollectiveVote(
  state: MutableServiceState,
  input: CloseCollectiveVoteRequest,
  human: Human,
  now: number,
): CollectiveVoteProjection {
  const actorScope = `human:${human.humanId}`;
  const replay = collaborationOperationReplay(state, {
    ...input,
    actorScope,
    payload: input,
    resourceKind: 'vote',
  });
  if (replay.existing)
    return projectCollectiveVote(requireVote(state, input.collectiveId, replay.existing.resourceId), now);
  const vote = mutableVote(state, input.collectiveId, input.voteId);
  const membership = requireMembership(state, input.collectiveId, human.humanId);
  if (vote.createdBy.humanId !== human.humanId && membership.role !== 'steward') {
    throw new CollectiveServiceError('VOTE_AUTHORITY_REQUIRED', 'Only the Vote creator or a steward can close it', 403);
  }
  const at = new Date(now).toISOString();
  if (vote.lifecycle === 'open') {
    vote.lifecycle = 'closed';
    vote.closedAt = at;
    vote.revision += 1;
    vote.updatedAt = at;
    vote.history.push({
      revision: vote.revision,
      action: 'closed',
      actor: { humanId: human.humanId, displayName: human.displayName },
      at,
    });
  }
  recordVoteOperation(state, replay, actorScope, vote, at);
  return projectCollectiveVote(vote, now);
}

export function projectCollectiveVote(vote: CollectiveVoteRecord, now: number): CollectiveVoteProjection {
  const status = vote.lifecycle === 'closed' ? 'closed' : Date.parse(vote.closesAt) <= now ? 'expired' : 'open';
  return { ...structuredClone(vote), status };
}

function requireVote(state: ServiceState, collectiveId: string, voteId: string): CollectiveVoteRecord {
  const vote = state.votes[voteId];
  if (!vote || vote.collectiveId !== collectiveId) {
    throw new CollectiveServiceError('VOTE_NOT_FOUND', 'Collective Vote was not found', 404);
  }
  return vote;
}

function mutableVote(state: MutableServiceState, collectiveId: string, voteId: string) {
  requireVote(state, collectiveId, voteId);
  const vote = state.votes[voteId];
  if (!vote) throw new CollectiveServiceError('VOTE_NOT_FOUND', 'Collective Vote was not found', 404);
  return vote;
}

function recordVoteOperation(
  state: MutableServiceState,
  replay: { key: string; fingerprint: string },
  actorScope: string,
  vote: CollectiveVoteRecord,
  recordedAt: string,
) {
  recordCollaborationOperation(state, {
    ...replay,
    actorScope,
    resourceKind: 'vote',
    resourceId: vote.voteId,
    revision: vote.revision,
    recordedAt,
  });
}
