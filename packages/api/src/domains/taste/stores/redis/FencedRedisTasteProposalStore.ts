import type { TasteProposal } from '@cat-cafe/shared';
import type { RedisClient } from '@cat-cafe/shared/utils';
import type { TasteDecisionAuthorityFence } from '../../services/RedisTasteDecisionAuthority.js';
import {
  matchesTasteDecisionSnapshot,
  TASTE_DECISION_FIELDS,
  type TasteDecisionSnapshot,
} from '../../services/taste-decision-snapshot.js';
import { TasteProposalKeys } from '../redis-keys/taste-proposal-keys.js';
import { RedisTasteProposalStore } from './RedisTasteProposalStore.js';

/** Candidate-only CAS: the Host token, proposal version and one-shot transition share one Redis operation. */
const CLAIM_FENCED_LUA = `
  if redis.call('HGET', KEYS[1], 'status') ~= 'pending' then return 0 end
  if redis.call('GET', KEYS[2]) ~= ARGV[1] or redis.call('PTTL', KEYS[2]) <= 0 then return 0 end
  for i = 2, #ARGV, 2 do
    if (redis.call('HGET', KEYS[1], ARGV[i]) or '') ~= ARGV[i + 1] then return 0 end
  end
  redis.call('HSET', KEYS[1], 'status', 'approving')
  redis.call('DEL', KEYS[2])
  return 1
`;

const REJECT_FENCED_LUA = `
  if redis.call('HGET', KEYS[1], 'status') ~= 'pending' then return 0 end
  if redis.call('GET', KEYS[4]) ~= ARGV[1] or redis.call('PTTL', KEYS[4]) <= 0 then return 0 end
  for i = 6, #ARGV, 2 do
    if (redis.call('HGET', KEYS[1], ARGV[i]) or '') ~= ARGV[i + 1] then return 0 end
  end
  redis.call('HSET', KEYS[1], 'status', 'rejected',
    'rejectedBy', ARGV[2],
    'rejectedAt', ARGV[3],
    'rejectionReason', ARGV[5])
  redis.call('ZREM', KEYS[2], ARGV[4])
  redis.call('ZADD', KEYS[3], ARGV[3], ARGV[4])
  redis.call('DEL', KEYS[4])
  return 1
`;

/** Never registered in production. Existing F221 approval routes keep their ordinary store. */
export class FencedRedisTasteProposalStore extends RedisTasteProposalStore {
  constructor(private readonly authorityRedis: RedisClient) {
    super(authorityRedis);
  }

  async claimForApprovalFenced(
    id: string,
    userId: string,
    expected: TasteDecisionSnapshot,
    fence: TasteDecisionAuthorityFence,
  ): Promise<TasteProposal | null> {
    if (!validFence(fence, id, userId) || expected.ownerUserId !== userId) return null;
    const proposal = await this.get(id);
    if (!proposal || !matchesTasteDecisionSnapshot(proposal, expected)) return null;
    const result = await this.authorityRedis.eval(
      CLAIM_FENCED_LUA,
      2,
      TasteProposalKeys.detail(id),
      TasteProposalKeys.decisionAuthority(userId, id),
      fence.token,
      ...snapshotFields(expected),
    );
    return result === 1 ? { ...proposal, status: 'approving' } : null;
  }

  async markRejectedFenced(
    id: string,
    reason: string,
    userId: string,
    expected: TasteDecisionSnapshot,
    fence: TasteDecisionAuthorityFence,
  ): Promise<TasteProposal | null> {
    if (!validFence(fence, id, userId) || expected.ownerUserId !== userId) return null;
    const proposal = await this.get(id);
    if (!proposal || !matchesTasteDecisionSnapshot(proposal, expected)) return null;
    const now = Date.now();
    const result = await this.authorityRedis.eval(
      REJECT_FENCED_LUA,
      4,
      TasteProposalKeys.detail(id),
      TasteProposalKeys.userPending(userId),
      TasteProposalKeys.userSettled(userId),
      TasteProposalKeys.decisionAuthority(userId, id),
      fence.token,
      userId,
      String(now),
      id,
      reason,
      ...snapshotFields(expected),
    );
    return result === 1
      ? { ...proposal, status: 'rejected', rejectedBy: userId, rejectedAt: now, rejectionReason: reason }
      : null;
  }
}

function snapshotFields(expected: TasteDecisionSnapshot): string[] {
  return TASTE_DECISION_FIELDS.flatMap((field) => [field, expected.fields[field]]);
}

function validFence(fence: TasteDecisionAuthorityFence, id: string, userId: string): boolean {
  return fence.proposalId === id && fence.ownerUserId === userId && /^[0-9a-f]{32,64}$/.test(fence.token);
}
