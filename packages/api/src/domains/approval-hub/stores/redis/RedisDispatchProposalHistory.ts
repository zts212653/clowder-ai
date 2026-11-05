import type { DispatchProposal } from '@cat-cafe/shared';
import type { RedisClient } from '@cat-cafe/shared/utils';
import { reconcileSettledIndexTime } from '../../../../utils/reconcile-settled-index-time.js';
import { advanceSettledIndex, SettledIndexPreparingError } from '../../../../utils/redis-settled-index.js';
import { readRedisSettledPage } from '../../../../utils/redis-settled-page.js';
import type { SettledHistoryPageOptions } from '../../../../utils/settled-history-page.js';
import { DispatchProposalKeys } from '../../../cats/services/stores/redis-keys/proposals/dispatch-proposal-keys.js';
import { computeLineageKey } from '../ports/IDispatchProposalStore.js';
import { hydrateDispatchProposal } from './RedisDispatchProposalSerde.js';

const settled = (proposal: DispatchProposal) => ['approved', 'rejected', 'superseded'].includes(proposal.status);

/** Legacy create supplies a time only with exact lineage and its canonical supersession receipt. */
async function closureTime(
  redis: RedisClient,
  proposal: DispatchProposal,
  guard?: (key: string, fields: Record<string, string | undefined>) => void,
): Promise<number> {
  if (proposal.status !== 'superseded') return proposal.decidedAt ?? 0;
  if (proposal.supersededAt !== undefined) return proposal.supersededAt;
  if (!proposal.supersededBy) return 0;
  const raw = await redis.hgetall(DispatchProposalKeys.detail(proposal.supersededBy));
  if (!raw.proposalId) return 0;
  guard?.(
    DispatchProposalKeys.detail(proposal.supersededBy),
    Object.fromEntries(
      [
        'proposalId',
        'ownerUserId',
        'sourceThreadId',
        'targetThreadId',
        'senderCatId',
        'createdAt',
        'supersededProposalIds',
      ].map((key) => [key, raw[key]]),
    ),
  );
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
  await prepareDispatchHistory(redis);
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

async function prepareDispatchHistory(redis: RedisClient) {
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
}

export async function pageRedisDispatchHistory(redis: RedisClient, owner: string, options: SettledHistoryPageOptions) {
  await prepareDispatchHistory(redis);
  return readRedisSettledPage(redis, DispatchProposalKeys.userSettled(owner), options, async (id, at) => {
    const raw = await redis.hgetall(DispatchProposalKeys.detail(id));
    if (!raw.proposalId) return null;
    const proposal = hydrateDispatchProposal(raw);
    if (proposal.proposalId !== id || proposal.ownerUserId !== owner || !settled(proposal))
      throw new Error('Settled index canonical identity/owner/status mismatch');
    const guards: Array<{ key: string; fields: Record<string, string | undefined> }> = [
      {
        key: DispatchProposalKeys.detail(id),
        fields: Object.fromEntries(
          [
            'proposalId',
            'status',
            'ownerUserId',
            'sourceThreadId',
            'targetThreadId',
            'senderCatId',
            'createdAt',
            'decidedAt',
            'supersededAt',
            'supersededBy',
          ].map((key) => [key, raw[key]]),
        ),
      },
    ];
    const time = await closureTime(redis, proposal, (key, fields) => guards.push({ key, fields }));
    await reconcileSettledIndexTime(redis, DispatchProposalKeys.userSettled(owner), id, at, time, guards);
    if (proposal.status === 'superseded') proposal.supersededAt = time;
    return proposal;
  });
}
