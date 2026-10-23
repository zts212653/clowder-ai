import type { ThreadProposal } from '@cat-cafe/shared';
import type { RedisClient } from '@cat-cafe/shared/utils';
import type { FinalizeApprovalInput } from '../ports/ProposalStoreContracts.js';
import { ProposalKeys } from '../redis-keys/proposals/proposal-keys.js';
import { finalizedProposalFields } from './RedisProposalStoreFields.js';
import { applyFinalize, hydrateProposal } from './RedisProposalStoreHelpers.js';
import { runWithExclusiveRedisWatchSession } from './RedisWatchSession.js';

/** Freeze the exact final contract atomically with its approval, including the stored envelope. */
export function finalizeRedisProposalApproval(
  redis: RedisClient,
  input: FinalizeApprovalInput,
): Promise<ThreadProposal | null> {
  const key = ProposalKeys.detail(input.proposalId);
  return runWithExclusiveRedisWatchSession(redis, key, async (session) => {
    const raw = await session.hgetall(key);
    if (
      !raw.proposalId ||
      raw.status !== 'approving' ||
      (raw.createdThreadId && raw.createdThreadId !== input.createdThreadId)
    )
      return null;
    const indexKey = ProposalKeys.userSettled(raw.createdBy);
    await session.watch(indexKey);
    const indexType = await session.type(indexKey);
    if (indexType !== 'none' && indexType !== 'zset') throw new Error('proposal history index type conflict');
    const updated = applyFinalize(hydrateProposal(raw), input, Date.now());
    const results = await session
      .multi()
      .hset(key, ...finalizedProposalFields(updated))
      .zadd(indexKey, updated.approvedAt!, updated.proposalId)
      .exec();
    if (!results) return null;
    const error = results.find(([err]) => err)?.[0];
    if (error) throw error;
    return updated;
  });
}
