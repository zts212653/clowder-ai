/** Atomic Redis transition for requester withdrawal of a pending F128 proposal. */

import type { ThreadProposal } from '@cat-cafe/shared';
import type { RedisClient } from '@cat-cafe/shared/utils';
import type { WithdrawProposalInput } from '../ports/ProposalStore.js';
import { ProposalKeys } from '../redis-keys/proposals/proposal-keys.js';
import { CAS_TRANSITION_LUA, hydrateProposal } from './RedisProposalStoreHelpers.js';

export async function withdrawPendingProposal(
  redis: RedisClient,
  input: WithdrawProposalInput,
): Promise<ThreadProposal | null> {
  const data = await redis.hgetall(ProposalKeys.detail(input.proposalId));
  if (!data?.proposalId) return null;
  const proposal = hydrateProposal(data);
  if (proposal.status !== 'pending') return null;

  const withdrawnAt = Date.now();
  const updated: ThreadProposal = {
    ...proposal,
    status: 'withdrawn',
    withdrawnBy: input.withdrawnBy,
    withdrawnAt,
  };
  const result = (await redis.eval(
    CAS_TRANSITION_LUA,
    2,
    ProposalKeys.detail(updated.proposalId),
    ProposalKeys.userPending(updated.createdBy),
    updated.proposalId,
    'pending',
    'zrem',
    '',
    'status',
    'withdrawn',
    'withdrawnBy',
    input.withdrawnBy,
    'withdrawnAt',
    String(withdrawnAt),
  )) as number;
  return result === 1 ? updated : null;
}
