import { randomBytes } from 'node:crypto';
import type { RedisClient } from '@cat-cafe/shared/utils';
import { TasteProposalKeys } from '../stores/redis-keys/taste-proposal-keys.js';

export interface TasteDecisionAuthorityFence {
  readonly ownerUserId: string;
  readonly proposalId: string;
  readonly token: string;
}

const REVOKE_IF_CURRENT_LUA = `
  if redis.call('GET', KEYS[1]) ~= ARGV[1] then return 0 end
  return redis.call('DEL', KEYS[1])
`;

/** Isolated F317 candidate. No production Host or writer registers this authority issuer. */
export class RedisTasteDecisionAuthority {
  constructor(private readonly redis: RedisClient) {}

  async issue(ownerUserId: string, proposalId: string, ttlMs = 120_000): Promise<TasteDecisionAuthorityFence> {
    if (!ownerUserId || !proposalId || !Number.isSafeInteger(ttlMs) || ttlMs < 1 || ttlMs > 120_000)
      throw new Error('Invalid F221 authority scope or lifetime');
    const token = randomBytes(24).toString('hex');
    await this.redis.set(TasteProposalKeys.decisionAuthority(ownerUserId, proposalId), token, 'PX', ttlMs);
    return { ownerUserId, proposalId, token };
  }

  async revoke(fence: TasteDecisionAuthorityFence): Promise<boolean> {
    return (
      (await this.redis.eval(
        REVOKE_IF_CURRENT_LUA,
        1,
        TasteProposalKeys.decisionAuthority(fence.ownerUserId, fence.proposalId),
        fence.token,
      )) === 1
    );
  }
}
