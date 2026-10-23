import type { DispatchProposal } from '@cat-cafe/shared';
import type { RedisClient } from '@cat-cafe/shared/utils';
import { advanceSettledIndex, SettledIndexPreparingError } from '../../../../utils/redis-settled-index.js';
import { DispatchProposalKeys } from '../../../cats/services/stores/redis-keys/proposals/dispatch-proposal-keys.js';
import { computeLineageKey } from '../ports/IDispatchProposalStore.js';
import { hydrateDispatchProposal } from './RedisDispatchProposalSerde.js';

const settled = (proposal: DispatchProposal) => ['approved', 'rejected', 'superseded'].includes(proposal.status);

/** Legacy create supplies a time only with exact lineage and its canonical supersession receipt. */
async function closureTime(redis: RedisClient, proposal: DispatchProposal): Promise<number> {
  if (proposal.status !== 'superseded') return proposal.decidedAt ?? 0;
  if (proposal.supersededAt !== undefined) return proposal.supersededAt;
  if (!proposal.supersededBy) return 0;
  const raw = await redis.hgetall(DispatchProposalKeys.detail(proposal.supersededBy));
  if (!raw.proposalId) return 0;
  const closedIds: unknown = raw.supersededProposalIds ? JSON.parse(raw.supersededProposalIds) : null;
  if (!Array.isArray(closedIds) || !closedIds.includes(proposal.proposalId)) return 0;
  const successor = hydrateDispatchProposal(raw);
  return successor.proposalId === proposal.supersededBy &&
    successor.ownerUserId === proposal.ownerUserId &&
    computeLineageKey(successor.sourceThreadId, successor.targetThreadId, successor.senderCatId) ===
      computeLineageKey(proposal.sourceThreadId, proposal.targetThreadId, proposal.senderCatId) &&
    successor.createdAt >= proposal.createdAt
    ? successor.createdAt
    : 0;
}

export async function listRedisDispatchHistory(
  redis: RedisClient,
  owner: string,
  limit: number,
): Promise<DispatchProposal[]> {
  if (!Number.isInteger(limit) || limit < 1 || limit > 200) throw new Error('invalid history limit');
  const ready = await advanceSettledIndex(redis, {
    progressKey: 'dispatch-proposal:history-index:v1',
    prefix: DispatchProposalKeys.detailPrefix,
    type: 'hash',
    entry: async (raw, key) => {
      const proposal = hydrateDispatchProposal(raw as Record<string, string>);
      if (!proposal.ownerUserId || key !== DispatchProposalKeys.detail(proposal.proposalId) || !settled(proposal))
        return null;
      return {
        indexKey: DispatchProposalKeys.userSettled(proposal.ownerUserId),
        id: proposal.proposalId,
        score: await closureTime(redis, proposal),
      };
    },
  });
  if (!ready) throw new SettledIndexPreparingError();
  const ids = await redis.zrevrange(DispatchProposalKeys.userSettled(owner), 0, limit - 1);
  if (!ids.length) return [];
  const pipeline = redis.pipeline();
  for (const id of ids) pipeline.hgetall(DispatchProposalKeys.detail(id));
  const results = await pipeline.exec();
  if (!results || results.length !== ids.length) throw new Error('dispatch history read incomplete');
  const proposals: DispatchProposal[] = [];
  for (const [error, raw] of results) {
    if (error) throw error;
    if (!raw || typeof raw !== 'object' || !Object.keys(raw).length) continue;
    const proposal = hydrateDispatchProposal(raw as Record<string, string>);
    if (proposal.ownerUserId !== owner || !settled(proposal)) continue;
    if (proposal.status === 'superseded') proposal.supersededAt = await closureTime(redis, proposal);
    proposals.push(proposal);
  }
  return proposals;
}
