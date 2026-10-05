import type {
  CollectiveBindingVoteRecord,
  CollectiveDecisionRecord,
  WithdrawCollectiveBindingVoteRequest,
} from '@cat-cafe/shared';
import {
  advanceBindingVote,
  bindingVoteInvalidationReason,
  mutableBindingVote,
  projectCollectiveBindingVote,
  recordBindingVoteOperation,
  requireBindingVote,
} from './collaboration-binding-vote.js';
import { collaborationOperationReplay } from './collaboration-operations.js';
import { CollectiveServiceError } from './errors.js';
import { createStableId } from './persistence.js';
import type { MutableServiceState } from './state.js';

type Human = { readonly humanId: string; readonly displayName: string };
type VoteResult = NonNullable<CollectiveBindingVoteRecord['result']>;

export function settleCollectiveBindingVote(
  state: MutableServiceState,
  input: WithdrawCollectiveBindingVoteRequest,
  human: Human,
  now: number,
) {
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
  if (vote.authority.humanId !== human.humanId) {
    throw new CollectiveServiceError(
      'BINDING_VOTE_AUTHORITY_REQUIRED',
      'Only the recorded authority can settle this Vote',
      403,
    );
  }
  if (vote.lifecycle !== 'open') return projectCollectiveBindingVote(state, vote, now);
  const invalidationReason = bindingVoteInvalidationReason(state, vote);
  const at = new Date(now).toISOString();
  if (invalidationReason) {
    vote.lifecycle = 'invalidated';
    vote.invalidationReason = invalidationReason;
    advanceBindingVote(vote, 'invalidated', human, at, undefined, invalidationReason);
    recordBindingVoteOperation(state, replay, actorScope, vote, at);
    return projectCollectiveBindingVote(state, vote, now);
  }
  if (now < Date.parse(vote.closesAt) && vote.ballots.length < vote.rules.eligibleVoters.length) {
    throw new CollectiveServiceError(
      'BINDING_VOTE_STILL_OPEN',
      'Binding Vote settles at its deadline or after every eligible Human has cast a ballot',
      409,
    );
  }
  const { result, winner } = bindingVoteResult(vote, at);
  vote.result = result;
  if (result.outcome === 'passed' && winner) createDecision(state, vote, result, winner, at);
  vote.lifecycle = 'settled';
  advanceBindingVote(vote, 'settled', human, at);
  recordBindingVoteOperation(state, replay, actorScope, vote, at);
  return projectCollectiveBindingVote(state, vote, now);
}

function bindingVoteResult(vote: CollectiveBindingVoteRecord, settledAt: string) {
  const counts = new Map<string, number>();
  for (const ballot of vote.ballots) {
    if (ballot.choice.kind === 'option') {
      counts.set(ballot.choice.optionId, (counts.get(ballot.choice.optionId) ?? 0) + 1);
    }
  }
  const winner = vote.options
    .map((option) => ({ option, count: counts.get(option.optionId) ?? 0 }))
    .sort((left, right) => right.count - left.count)[0];
  const common = {
    eligibleCount: vote.rules.eligibleVoters.length,
    participationCount: vote.ballots.length,
    supportCount: winner?.count ?? 0,
    settledAt,
  };
  const result: VoteResult =
    winner && winner.count >= vote.rules.passCount && vote.ballots.length >= vote.rules.quorumCount
      ? { outcome: 'passed', winningOptionId: winner.option.optionId, ...common }
      : { outcome: 'no_decision', ...common };
  return { result, winner };
}

function createDecision(
  state: MutableServiceState,
  vote: MutableServiceState['bindingVotes'][string],
  result: Extract<VoteResult, { outcome: 'passed' }>,
  winner: { option: CollectiveBindingVoteRecord['options'][number] },
  createdAt: string,
) {
  const decisionId = createStableId('decision_');
  const decision: CollectiveDecisionRecord = {
    v: 1,
    serviceInstanceId: vote.serviceInstanceId,
    collectiveId: vote.collectiveId,
    decisionId,
    bindingVoteId: vote.bindingVoteId,
    sourceEventId: vote.sourceEventId,
    sourceLocation: vote.sourceLocation,
    statement: winner.option.label,
    target: vote.target,
    authority: vote.authority,
    rules: vote.rules,
    result,
    createdAt,
  };
  state.decisions[decisionId] = decision;
  vote.decisionId = decisionId;
}
