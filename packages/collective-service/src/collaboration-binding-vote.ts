import type {
  CastCollectiveBindingVoteRequest,
  CollectiveBindingVoteChoice,
  CollectiveBindingVoteProjection,
  CollectiveBindingVoteRecord,
  CreateCollectiveBindingVoteRequest,
  WithdrawCollectiveBindingVoteRequest,
} from '@cat-cafe/shared';
import { requireRoadmap } from './collaboration-command-helpers.js';
import { collaborationOperationReplay, recordCollaborationOperation } from './collaboration-operations.js';
import { CollectiveServiceError } from './errors.js';
import { createStableId } from './persistence.js';
import { type MutableServiceState, membershipKey, type ServiceState } from './state.js';

type Human = { readonly humanId: string; readonly displayName: string };

export function createCollectiveBindingVote(
  state: MutableServiceState,
  input: CreateCollectiveBindingVoteRequest,
  human: Human,
  now: number,
): CollectiveBindingVoteProjection {
  const actorScope = `human:${human.humanId}`;
  const replay = collaborationOperationReplay(state, {
    ...input,
    actorScope,
    payload: input,
    resourceKind: 'binding_vote',
  });
  if (replay.existing) {
    return projectCollectiveBindingVote(
      state,
      requireBindingVote(state, input.collectiveId, replay.existing.resourceId),
      now,
    );
  }
  const roadmap = requireRoadmap(state, input.collectiveId, input.roadmapId);
  if (roadmap.accountableHumanId !== human.humanId) {
    throw new CollectiveServiceError(
      'BINDING_VOTE_AUTHORITY_REQUIRED',
      'Only the accountable Human can bind a decision to this Roadmap',
      403,
    );
  }
  if (roadmap.revision !== input.expectedRoadmapRevision) {
    throw new CollectiveServiceError('BINDING_VOTE_TARGET_CHANGED', 'Roadmap changed; start a new decision round', 409);
  }
  const openRound = Object.values(state.bindingVotes).some(
    (vote) =>
      vote.collectiveId === input.collectiveId &&
      vote.target.roadmapId === roadmap.roadmapId &&
      vote.target.roadmapRevision === roadmap.revision &&
      vote.lifecycle === 'open',
  );
  if (openRound) {
    throw new CollectiveServiceError(
      'BINDING_VOTE_ALREADY_OPEN',
      'Settle or invalidate the existing decision round before opening another',
      409,
    );
  }
  const closesAt = Date.parse(input.closesAt);
  if (!Number.isFinite(closesAt) || closesAt <= now || closesAt > now + 30 * 24 * 60 * 60 * 1_000) {
    throw new CollectiveServiceError(
      'BINDING_VOTE_DEADLINE_INVALID',
      'Binding Vote deadline must be within 30 days',
      409,
    );
  }
  const labels = input.options.map((option) => option.trim());
  if (new Set(labels.map((label) => label.toLocaleLowerCase())).size !== labels.length) {
    throw new CollectiveServiceError('BINDING_VOTE_OPTIONS_INVALID', 'Binding Vote options must be distinct', 409);
  }
  const eligibleVoters = Object.values(state.memberships)
    .filter((membership) => membership.collectiveId === input.collectiveId && membership.status === 'active')
    .map((membership) => state.humans[membership.humanId])
    .filter((candidate): candidate is NonNullable<typeof candidate> => Boolean(candidate))
    .map(({ humanId, displayName }) => ({ humanId, displayName }))
    .sort((left, right) => left.humanId.localeCompare(right.humanId));
  const majority = Math.floor(eligibleVoters.length / 2) + 1;
  const at = new Date(now).toISOString();
  const bindingVoteId = createStableId('binding_vote_');
  const actor = { humanId: human.humanId, displayName: human.displayName };
  const vote: CollectiveBindingVoteRecord = {
    v: 1,
    serviceInstanceId: state.serviceInstanceId,
    collectiveId: input.collectiveId,
    bindingVoteId,
    sourceEventId: roadmap.sourceEventId,
    sourceLocation: roadmap.sourceLocation,
    kind: 'binding_vote',
    question: input.question,
    options: labels.map((label) => ({ optionId: createStableId('vote_option_'), label })),
    ballots: [],
    target: { kind: 'roadmap', roadmapId: roadmap.roadmapId, roadmapRevision: roadmap.revision },
    authority: {
      kind: 'roadmap_accountable_human',
      humanId: human.humanId,
      scope: 'decision_only',
      evidenceRef: `roadmap:${roadmap.roadmapId}@${roadmap.revision}:accountable:${human.humanId}`,
    },
    rules: {
      version: 1,
      eligibleVoters,
      quorumCount: majority,
      passCount: majority,
      allowAbstain: true,
      settlement: 'deadline_or_all_ballots',
    },
    closesAt: input.closesAt,
    lifecycle: 'open',
    revision: 1,
    createdAt: at,
    updatedAt: at,
    history: [{ revision: 1, action: 'created', actor, at }],
  };
  state.bindingVotes[bindingVoteId] = vote;
  recordBindingVoteOperation(state, replay, actorScope, vote, at);
  return projectCollectiveBindingVote(state, vote, now);
}

export function castCollectiveBindingVote(
  state: MutableServiceState,
  input: CastCollectiveBindingVoteRequest,
  human: Human,
  now: number,
) {
  return changeBallot(state, input, human, now, input.choice);
}

export function withdrawCollectiveBindingVote(
  state: MutableServiceState,
  input: WithdrawCollectiveBindingVoteRequest,
  human: Human,
  now: number,
) {
  return changeBallot(state, input, human, now);
}

export function projectCollectiveBindingVote(
  state: ServiceState,
  vote: CollectiveBindingVoteRecord,
  now: number,
): CollectiveBindingVoteProjection {
  const invalid = vote.lifecycle === 'open' ? bindingVoteInvalidationReason(state, vote) : undefined;
  const status = invalid
    ? 'invalidated'
    : vote.lifecycle === 'settled'
      ? 'settled'
      : vote.lifecycle === 'invalidated'
        ? 'invalidated'
        : Date.parse(vote.closesAt) <= now
          ? 'expired'
          : 'open';
  return { ...structuredClone(vote), status };
}

function changeBallot(
  state: MutableServiceState,
  input: CastCollectiveBindingVoteRequest | WithdrawCollectiveBindingVoteRequest,
  human: Human,
  now: number,
  choice?: CollectiveBindingVoteChoice,
): CollectiveBindingVoteProjection {
  const actorScope = `human:${human.humanId}`;
  const replay = collaborationOperationReplay(state, {
    ...input,
    actorScope,
    payload: input,
    resourceKind: 'binding_vote',
  });
  if (replay.existing) {
    return projectCollectiveBindingVote(
      state,
      requireBindingVote(state, input.collectiveId, replay.existing.resourceId),
      now,
    );
  }
  const vote = mutableBindingVote(state, input.collectiveId, input.bindingVoteId);
  if (projectCollectiveBindingVote(state, vote, now).status !== 'open') {
    throw new CollectiveServiceError('BINDING_VOTE_CLOSED', 'This binding Vote no longer accepts ballots', 409);
  }
  if (!vote.rules.eligibleVoters.some((voter) => voter.humanId === human.humanId)) {
    throw new CollectiveServiceError('BINDING_VOTE_INELIGIBLE', 'This Human was not in the frozen voter snapshot', 403);
  }
  if (choice?.kind === 'option' && !vote.options.some((option) => option.optionId === choice.optionId)) {
    throw new CollectiveServiceError('BINDING_VOTE_OPTION_INVALID', 'Binding Vote option was not found', 404);
  }
  const at = new Date(now).toISOString();
  const index = vote.ballots.findIndex((ballot) => ballot.humanId === human.humanId);
  const current = vote.ballots[index];
  const changed = JSON.stringify(current?.choice) !== JSON.stringify(choice);
  if (changed) {
    if (choice) {
      const ballot = { humanId: human.humanId, displayName: human.displayName, choice, castAt: at };
      if (index >= 0) vote.ballots[index] = ballot;
      else vote.ballots.push(ballot);
      advanceBindingVote(vote, current ? 'ballot_changed' : 'ballot_cast', human, at, choice);
    } else if (index >= 0) {
      vote.ballots.splice(index, 1);
      advanceBindingVote(vote, 'ballot_withdrawn', human, at);
    }
  }
  recordBindingVoteOperation(state, replay, actorScope, vote, at);
  return projectCollectiveBindingVote(state, vote, now);
}

export function advanceBindingVote(
  vote: MutableServiceState['bindingVotes'][string],
  action: 'ballot_cast' | 'ballot_changed' | 'ballot_withdrawn' | 'settled' | 'invalidated',
  human: Human,
  at: string,
  choice?: CollectiveBindingVoteChoice,
  note?: string,
) {
  vote.revision += 1;
  vote.updatedAt = at;
  vote.history.push({
    revision: vote.revision,
    action,
    actor: { humanId: human.humanId, displayName: human.displayName },
    at,
    ...(choice ? { choice } : {}),
    ...(note ? { note } : {}),
  });
}

export function bindingVoteInvalidationReason(
  state: ServiceState,
  vote: CollectiveBindingVoteRecord,
): 'eligible_voter_lost_access' | 'roadmap_authority_changed' | undefined {
  if (
    vote.rules.eligibleVoters.some(
      (voter) => state.memberships[membershipKey(vote.collectiveId, voter.humanId)]?.status !== 'active',
    )
  ) {
    return 'eligible_voter_lost_access';
  }
  const roadmap = state.roadmaps[vote.target.roadmapId];
  if (
    !roadmap ||
    roadmap.collectiveId !== vote.collectiveId ||
    roadmap.accountableHumanId !== vote.authority.humanId ||
    roadmap.revision !== vote.target.roadmapRevision
  ) {
    return 'roadmap_authority_changed';
  }
  return undefined;
}

export function requireBindingVote(state: ServiceState, collectiveId: string, bindingVoteId: string) {
  const vote = state.bindingVotes[bindingVoteId];
  if (!vote || vote.collectiveId !== collectiveId) {
    throw new CollectiveServiceError('BINDING_VOTE_NOT_FOUND', 'Collective binding Vote was not found', 404);
  }
  return vote;
}

export function mutableBindingVote(state: MutableServiceState, collectiveId: string, bindingVoteId: string) {
  requireBindingVote(state, collectiveId, bindingVoteId);
  const vote = state.bindingVotes[bindingVoteId];
  if (!vote) throw new CollectiveServiceError('BINDING_VOTE_NOT_FOUND', 'Collective binding Vote was not found', 404);
  return vote;
}

export function recordBindingVoteOperation(
  state: MutableServiceState,
  replay: { key: string; fingerprint: string },
  actorScope: string,
  vote: CollectiveBindingVoteRecord,
  recordedAt: string,
) {
  recordCollaborationOperation(state, {
    ...replay,
    actorScope,
    resourceKind: 'binding_vote',
    resourceId: vote.bindingVoteId,
    revision: vote.revision,
    recordedAt,
  });
}
