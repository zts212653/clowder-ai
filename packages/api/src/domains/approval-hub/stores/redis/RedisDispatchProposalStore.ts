/**
 * F246 Phase B: Redis-backed DispatchProposal store.
 *
 * Persists assign_work cross-thread dispatch proposals pending operator approval.
 * Lifecycle: create(pending) → approve/reject(terminal).
 *
 * Iron Law #5 (LL-048): User-visible state defaults to TTL=0 (persistent).
 * Pending dispatch proposals are user-visible in the Approval Hub and hold
 * intercepted message content — expiry would silently drop messages.
 */

import type { DispatchProposal } from '@cat-cafe/shared';
import type { RedisClient } from '@cat-cafe/shared/utils';
import { DispatchProposalKeys } from '../../../cats/services/stores/redis-keys/dispatch-proposal-keys.js';
import type { CreateDispatchProposalInput, IDispatchProposalStore } from '../ports/IDispatchProposalStore.js';

/** CAS transition: pending → approved. Atomic status check + field update + index removal.
 *  deliveredMessageId is recorded separately via recordDelivery() AFTER successful delivery,
 *  so the CAS transition never leaks a delivery on a lost race (R2 P1-2 fix). */
const CAS_APPROVE_LUA = `
  local key = KEYS[1]
  local pendingKey = KEYS[2]
  local status = redis.call('HGET', key, 'status')
  if status ~= 'pending' then return 0 end
  redis.call('HSET', key, 'status', 'approved',
    'decidedAt', ARGV[1],
    'decidedBy', ARGV[2])
  redis.call('ZREM', pendingKey, ARGV[3])
  return 1
`;

/** CAS rollback: approved → pending. Restores retryability when delivery fails (Cloud P1-2 fix). */
const CAS_REVERT_PENDING_LUA = `
  local key = KEYS[1]
  local pendingKey = KEYS[2]
  local status = redis.call('HGET', key, 'status')
  if status ~= 'approved' then return 0 end
  redis.call('HSET', key, 'status', 'pending')
  redis.call('HDEL', key, 'decidedAt', 'decidedBy')
  redis.call('ZADD', pendingKey, ARGV[1], ARGV[2])
  return 1
`;

/** CAS transition: pending → rejected. Atomic status check + field update + index removal. */
const CAS_REJECT_LUA = `
  local key = KEYS[1]
  local pendingKey = KEYS[2]
  local status = redis.call('HGET', key, 'status')
  if status ~= 'pending' then return 0 end
  redis.call('HSET', key, 'status', 'rejected',
    'decidedAt', ARGV[1],
    'decidedBy', ARGV[2])
  redis.call('ZREM', pendingKey, ARGV[3])
  return 1
`;

export class RedisDispatchProposalStore implements IDispatchProposalStore {
  constructor(private readonly redis: RedisClient) {}

  async create(input: CreateDispatchProposalInput): Promise<DispatchProposal> {
    const proposal: DispatchProposal = {
      ...input,
      effectClass: 'assign_work',
      status: 'pending',
    };

    const key = DispatchProposalKeys.detail(input.proposalId);
    const pendingKey = DispatchProposalKeys.userPending(input.ownerUserId);

    // Cloud P2-1 fix: atomic idempotency claim — SET NX first, fail if already claimed.
    if (input.clientMessageId) {
      const dedupKey = DispatchProposalKeys.clientMsg(input.sourceThreadId, input.clientMessageId);
      const claimed = await this.redis.set(dedupKey, input.proposalId, 'NX');
      if (!claimed) {
        // Another concurrent create already claimed this clientMessageId.
        // Return the existing proposal instead of creating a duplicate.
        const existingId = await this.redis.get(dedupKey);
        if (existingId) {
          const existing = await this.get(existingId);
          if (existing) return existing;
        }
        // Fallback: dedup key exists but proposal vanished — proceed with create
      }
    }

    const pipeline = this.redis.multi();
    pipeline.hset(key, ...serializeProposal(proposal));
    pipeline.zadd(pendingKey, input.createdAt, input.proposalId);

    await pipeline.exec();
    return proposal;
  }

  async get(proposalId: string): Promise<DispatchProposal | null> {
    const key = DispatchProposalKeys.detail(proposalId);
    const raw = await this.redis.hgetall(key);
    if (!raw || Object.keys(raw).length === 0) return null;
    return hydrateProposal(raw);
  }

  async listPendingByUser(userId: string): Promise<DispatchProposal[]> {
    const pendingKey = DispatchProposalKeys.userPending(userId);
    // Reverse order: newest first (highest score = most recent createdAt)
    const ids = await this.redis.zrevrange(pendingKey, 0, -1);
    if (!ids.length) return [];

    const pipeline = this.redis.pipeline();
    for (const id of ids) {
      pipeline.hgetall(DispatchProposalKeys.detail(id));
    }
    const results = await pipeline.exec();
    if (!results) return [];

    const proposals: DispatchProposal[] = [];
    for (const [err, raw] of results) {
      if (err || !raw || typeof raw !== 'object' || Object.keys(raw as Record<string, string>).length === 0) continue;
      const p = hydrateProposal(raw as Record<string, string>);
      // Double-check status in case of race between ZREM and this read
      if (p.status === 'pending') proposals.push(p);
    }
    return proposals;
  }

  async approve(proposalId: string, userId: string): Promise<DispatchProposal | null> {
    const proposal = await this.get(proposalId);
    if (!proposal) return null;

    const key = DispatchProposalKeys.detail(proposalId);
    const pendingKey = DispatchProposalKeys.userPending(proposal.ownerUserId);
    const now = Date.now();

    const result = await this.redis.eval(CAS_APPROVE_LUA, 2, key, pendingKey, String(now), userId, proposalId);

    if (result === 0) return null;

    return {
      ...proposal,
      status: 'approved',
      decidedAt: now,
      decidedBy: userId,
    };
  }

  async recordDelivery(proposalId: string, deliveredMessageId: string): Promise<void> {
    const key = DispatchProposalKeys.detail(proposalId);
    await this.redis.hset(key, 'deliveredMessageId', deliveredMessageId);
  }

  async revertToPending(proposalId: string): Promise<DispatchProposal | null> {
    const proposal = await this.get(proposalId);
    if (!proposal) return null;

    const key = DispatchProposalKeys.detail(proposalId);
    const pendingKey = DispatchProposalKeys.userPending(proposal.ownerUserId);

    const result = await this.redis.eval(
      CAS_REVERT_PENDING_LUA,
      2,
      key,
      pendingKey,
      String(proposal.createdAt),
      proposalId,
    );

    if (result === 0) return null;

    return {
      ...proposal,
      status: 'pending',
      decidedAt: undefined,
      decidedBy: undefined,
    };
  }

  async reject(proposalId: string, userId: string): Promise<DispatchProposal | null> {
    const proposal = await this.get(proposalId);
    if (!proposal) return null;

    const key = DispatchProposalKeys.detail(proposalId);
    const pendingKey = DispatchProposalKeys.userPending(proposal.ownerUserId);
    const now = Date.now();

    const result = await this.redis.eval(CAS_REJECT_LUA, 2, key, pendingKey, String(now), userId, proposalId);

    if (result === 0) return null;

    return {
      ...proposal,
      status: 'rejected',
      decidedAt: now,
      decidedBy: userId,
    };
  }

  async findByClientMessageId(clientMessageId: string, sourceThreadId: string): Promise<DispatchProposal | null> {
    const dedupKey = DispatchProposalKeys.clientMsg(sourceThreadId, clientMessageId);
    const proposalId = await this.redis.get(dedupKey);
    if (!proposalId) return null;
    return this.get(proposalId);
  }
}

// ---------------------------------------------------------------------------
// Serialization helpers (hash field ↔ DispatchProposal)
// ---------------------------------------------------------------------------

function serializeProposal(p: DispatchProposal): string[] {
  const fields: string[] = [
    'proposalId',
    p.proposalId,
    'sourceThreadId',
    p.sourceThreadId,
    'targetThreadId',
    p.targetThreadId,
    'senderCatId',
    p.senderCatId,
    'ownerUserId',
    p.ownerUserId,
    'effectClass',
    p.effectClass,
    'content',
    p.content,
    'targetCats',
    JSON.stringify(p.targetCats),
    'status',
    p.status,
    'createdAt',
    String(p.createdAt),
  ];
  if (p.replyTo) fields.push('replyTo', p.replyTo);
  if (p.clientMessageId) fields.push('clientMessageId', p.clientMessageId);
  if (p.cardMessageId) fields.push('cardMessageId', p.cardMessageId);
  if (p.deliveredMessageId) fields.push('deliveredMessageId', p.deliveredMessageId);
  if (p.decidedAt != null) fields.push('decidedAt', String(p.decidedAt));
  if (p.decidedBy) fields.push('decidedBy', p.decidedBy);
  return fields;
}

function hydrateProposal(raw: Record<string, string>): DispatchProposal {
  return {
    proposalId: raw.proposalId,
    sourceThreadId: raw.sourceThreadId,
    targetThreadId: raw.targetThreadId,
    senderCatId: raw.senderCatId,
    ownerUserId: raw.ownerUserId,
    effectClass: 'assign_work',
    content: raw.content,
    targetCats: JSON.parse(raw.targetCats || '[]'),
    status: raw.status as DispatchProposal['status'],
    createdAt: Number(raw.createdAt),
    ...(raw.replyTo ? { replyTo: raw.replyTo } : {}),
    ...(raw.clientMessageId ? { clientMessageId: raw.clientMessageId } : {}),
    ...(raw.cardMessageId ? { cardMessageId: raw.cardMessageId } : {}),
    ...(raw.deliveredMessageId ? { deliveredMessageId: raw.deliveredMessageId } : {}),
    ...(raw.decidedAt ? { decidedAt: Number(raw.decidedAt) } : {}),
    ...(raw.decidedBy ? { decidedBy: raw.decidedBy } : {}),
  };
}
