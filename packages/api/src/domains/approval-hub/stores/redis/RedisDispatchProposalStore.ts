import type { ApprovalEnvelope, ApprovalPublication, DispatchProposal } from '@cat-cafe/shared';
import { assertApprovalEnvelopeIdentity } from '@cat-cafe/shared';
import type { RedisClient } from '@cat-cafe/shared/utils';
import { type OwnerAuthProvenance, requireOwnerAuthProvenance } from '../../../cats/services/owner-auth-provenance.js';
import { commitRedisApprovalEnvelope } from '../../../cats/services/stores/redis/RedisApprovalPublication.js';
import { DispatchProposalKeys } from '../../../cats/services/stores/redis-keys/proposals/dispatch-proposal-keys.js';
import type { ApprovalPublicationStore } from '../../ports/ApprovalPublicationStore.js';
import {
  type CreateDispatchProposalInput,
  type CreateDispatchProposalResult,
  computeLineageKey,
  type DispatchLegacyNegativeAuthorizationLookup,
  type DispatchNegativeAuthorizationBlock,
  type DispatchNegativeAuthorizationLookup,
  type IDispatchProposalStore,
} from '../ports/IDispatchProposalStore.js';
import { createRedisDispatchProposal } from './RedisDispatchProposalCreate.js';
import { RedisDispatchProposalNegativeAuthorization } from './RedisDispatchProposalNegativeAuthorization.js';
import { abortRedisDispatchStaged } from './RedisDispatchProposalRollback.js';
import { hydrateDispatchProposal } from './RedisDispatchProposalSerde.js';

/** CAS transition: pending → approved. Atomic status check + field update + index ops.
 *  deliveredMessageId is recorded separately via recordDelivery() AFTER successful delivery,
 *  so the CAS transition never leaks a delivery on a lost race (R2 P1-2 fix).
 *  KEYS[3] = userSettled sorted set (F246 Phase F history index, score=decidedAt). */
const CAS_APPROVE_LUA = `
  local key = KEYS[1]
  local pendingKey = KEYS[2]
  local settledKey = KEYS[3]
  local status = redis.call('HGET', key, 'status')
  if status ~= 'pending' then return 0 end
  redis.call('HSET', key, 'status', 'approved',
    'decidedAt', ARGV[1],
    'decidedBy', ARGV[2],
    'approvalOwnerAuthProvenance', ARGV[4])
  redis.call('ZREM', pendingKey, ARGV[3])
  redis.call('ZADD', settledKey, ARGV[1], ARGV[3])
  for i = 4, #KEYS do
    redis.call('ZREM', KEYS[i], ARGV[3])
  end
  return 1
`;

/**
 * CAS rollback: approved → pending, with Phase J lineage guard (INV-J5).
 * If a successor holds the lineage, marks as superseded instead of reverting
 * (prevents dual pending on delivery-failure rollback).
 *
 * KEYS[1] = proposal hash, KEYS[2] = pending set, KEYS[3] = settled set, KEYS[4] = lineage key.
 * ARGV[1] = createdAt, ARGV[2] = proposalId.
 *
 * Returns: 1 = reverted to pending, 2 = superseded (successor exists), 0 = not approved.
 */
const CAS_REVERT_PENDING_LUA = `
  local key = KEYS[1]
  local pendingKey = KEYS[2]
  local settledKey = KEYS[3]
  local lineageKey = KEYS[4]
  local status = redis.call('HGET', key, 'status')
  if status ~= 'approved' then return 0 end

  local currentHolder = redis.call('GET', lineageKey)
  if currentHolder and currentHolder ~= ARGV[2] then
    redis.call('HSET', key, 'status', 'superseded', 'supersededBy', currentHolder)
    redis.call('HDEL', key, 'decidedAt', 'decidedBy', 'approvalOwnerAuthProvenance')
    redis.call('ZREM', settledKey, ARGV[2])
    for i = 5, #KEYS do
      redis.call('ZADD', KEYS[i], tonumber(ARGV[1]), ARGV[2])
    end
    return 2
  end

  redis.call('HSET', key, 'status', 'pending')
  redis.call('HDEL', key, 'decidedAt', 'decidedBy', 'approvalOwnerAuthProvenance')
  redis.call('ZADD', pendingKey, ARGV[1], ARGV[2])
  redis.call('ZREM', settledKey, ARGV[2])
  redis.call('SET', lineageKey, ARGV[2])
  for i = 5, #KEYS do
    redis.call('ZADD', KEYS[i], tonumber(ARGV[1]), ARGV[2])
  end
  return 1
`;

/** CAS transition: pending → rejected. Atomic status check + field update + index ops.
 *  KEYS[3] = userSettled sorted set (F246 Phase F history index, score=decidedAt). */
const CAS_REJECT_LUA = `
  local key = KEYS[1]
  local pendingKey = KEYS[2]
  local settledKey = KEYS[3]
  local status = redis.call('HGET', key, 'status')
  if status ~= 'pending' then return 0 end
  redis.call('HSET', key, 'status', 'rejected',
    'decidedAt', ARGV[1],
    'decidedBy', ARGV[2])
  redis.call('ZREM', pendingKey, ARGV[3])
  redis.call('ZADD', settledKey, ARGV[1], ARGV[3])
  return 1
`;

/** Canonical persistent proposal store; denial indexes remain derived projections. */
export class RedisDispatchProposalStore implements IDispatchProposalStore, ApprovalPublicationStore {
  private readonly negativeAuthorization: RedisDispatchProposalNegativeAuthorization;

  constructor(private readonly redis: RedisClient) {
    this.negativeAuthorization = new RedisDispatchProposalNegativeAuthorization(redis);
  }

  async create(input: CreateDispatchProposalInput): Promise<CreateDispatchProposalResult> {
    return createRedisDispatchProposal(this.redis, input);
  }

  async get(proposalId: string): Promise<DispatchProposal | null> {
    const key = DispatchProposalKeys.detail(proposalId);
    const raw = await this.redis.hgetall(key);
    if (!raw || Object.keys(raw).length === 0) return null;
    return hydrateDispatchProposal(raw);
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
      const p = hydrateDispatchProposal(raw as Record<string, string>);
      // Double-check status in case of race between ZREM and this read
      if (p.status === 'pending') proposals.push(p);
    }
    return proposals;
  }

  async approve(
    proposalId: string,
    userId: string,
    ownerAuthProvenance: OwnerAuthProvenance = 'unknown',
  ): Promise<DispatchProposal | null> {
    const proposal = await this.get(proposalId);
    if (!proposal) return null;
    const provenance = requireOwnerAuthProvenance(ownerAuthProvenance);

    const key = DispatchProposalKeys.detail(proposalId);
    const pendingKey = DispatchProposalKeys.userPending(proposal.ownerUserId);
    const settledKey = DispatchProposalKeys.userSettled(proposal.ownerUserId);
    const negativeAuthorizationKeys = this.negativeAuthorization.keysForProposal(proposal);
    const now = Date.now();

    const result = await this.redis.eval(
      CAS_APPROVE_LUA,
      3 + negativeAuthorizationKeys.length,
      key,
      pendingKey,
      settledKey,
      ...negativeAuthorizationKeys,
      String(now),
      userId,
      proposalId,
      provenance,
    );

    if (result === 0) return null;

    return {
      ...proposal,
      status: 'approved',
      decidedAt: now,
      decidedBy: userId,
    };
  }

  async getApprovalOwnerAuthProvenance(proposalId: string): Promise<OwnerAuthProvenance | undefined> {
    const value = await this.redis.hget(DispatchProposalKeys.detail(proposalId), 'approvalOwnerAuthProvenance');
    return value === null ? undefined : requireOwnerAuthProvenance(value);
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
    const settledKey = DispatchProposalKeys.userSettled(proposal.ownerUserId);

    // Phase J (INV-J5): pass lineage key so Lua can check for successor.
    // If a newer proposal holds the lineage, revert → superseded (not pending).
    const K = computeLineageKey(proposal.sourceThreadId, proposal.targetThreadId, proposal.senderCatId);
    const lineageKeyRedis = DispatchProposalKeys.lineage(K);
    const negativeAuthorizationKeys = this.negativeAuthorization.keysForProposal(proposal);

    const result = await this.redis.eval(
      CAS_REVERT_PENDING_LUA,
      4 + negativeAuthorizationKeys.length,
      key,
      pendingKey,
      settledKey,
      lineageKeyRedis,
      ...negativeAuthorizationKeys,
      String(proposal.createdAt),
      proposalId,
    );

    // 0 = not approved, 2 = superseded (successor holds lineage) — both return null
    if (result === 0 || result === 2) return null;

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
    const settledKey = DispatchProposalKeys.userSettled(proposal.ownerUserId);
    const now = Date.now();

    const result = await this.redis.eval(
      CAS_REJECT_LUA,
      3,
      key,
      pendingKey,
      settledKey,
      String(now),
      userId,
      proposalId,
    );

    if (result === 0) return null;

    return {
      ...proposal,
      status: 'rejected',
      decidedAt: now,
      decidedBy: userId,
    };
  }

  async listSettledByUser(userId: string, limit: number): Promise<DispatchProposal[]> {
    const settledKey = DispatchProposalKeys.userSettled(userId);
    // Reverse order: newest first (highest score = most recent decidedAt)
    const ids = await this.redis.zrevrange(settledKey, 0, limit - 1);
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
      const p = hydrateDispatchProposal(raw as Record<string, string>);
      if (p.status === 'approved' || p.status === 'rejected') proposals.push(p);
    }
    return proposals;
  }

  async findByClientMessageId(clientMessageId: string, sourceThreadId: string): Promise<DispatchProposal | null> {
    const dedupKey = DispatchProposalKeys.clientMsg(sourceThreadId, clientMessageId);
    const proposalId = await this.redis.get(dedupKey);
    if (!proposalId) return null;
    return this.get(proposalId);
  }

  async findNegativeAuthorizationBlocks(
    input: DispatchNegativeAuthorizationLookup,
  ): Promise<DispatchNegativeAuthorizationBlock[]> {
    return this.negativeAuthorization.findBlocks(input);
  }

  async findLegacyNegativeAuthorizationBlocks(
    input: DispatchLegacyNegativeAuthorizationLookup,
  ): Promise<DispatchNegativeAuthorizationBlock[]> {
    return this.negativeAuthorization.findLegacyBlocks(input);
  }

  async getNegativeAuthorizationLegacyCutoverAt(): Promise<number | undefined> {
    return this.negativeAuthorization.getLegacyCutoverAt();
  }

  async establishNegativeAuthorizationLegacyCutoverAt(cutoverAt: number): Promise<number> {
    return this.negativeAuthorization.establishLegacyCutoverAt(cutoverAt);
  }

  async rebuildNegativeAuthorizationIndexes(): Promise<{ exactIndexed: number; legacyIndexed: number }> {
    return this.negativeAuthorization.rebuildIndexes();
  }

  // ---------------------------------------------------------------------------
  // ApprovalPublicationStore (Phase-I publication envelope)
  // ---------------------------------------------------------------------------

  async getPublication(proposalId: string): Promise<ApprovalPublication | null> {
    return (await this.get(proposalId))?.publication ?? null;
  }

  async commitEnvelope(proposalId: string, envelope: ApprovalEnvelope): Promise<void> {
    const proposal = await this.get(proposalId);
    if (!proposal) throw new Error(`proposal not found: ${proposalId}`);
    assertApprovalEnvelopeIdentity(envelope, {
      canonicalProposalId: proposal.proposalId,
      sourceFeatureId: 'F193',
      ownerUserId: proposal.ownerUserId,
      requesterCatId: proposal.senderCatId,
      createdAt: proposal.createdAt,
    });
    await commitRedisApprovalEnvelope(this.redis, DispatchProposalKeys.detail(proposalId), envelope);
  }

  async abortStaged(proposalId: string, _reason: string): Promise<void> {
    const proposal = await this.get(proposalId);
    if (!proposal) return;
    const K = computeLineageKey(proposal.sourceThreadId, proposal.targetThreadId, proposal.senderCatId);
    const lineageKeyRedis = DispatchProposalKeys.lineage(K);
    const conditionalDeleteKey = proposal.clientMessageId
      ? DispatchProposalKeys.clientMsg(proposal.sourceThreadId, proposal.clientMessageId)
      : undefined;
    await abortRedisDispatchStaged(this.redis, {
      detailKey: DispatchProposalKeys.detail(proposalId),
      pendingKey: DispatchProposalKeys.userPending(proposal.ownerUserId),
      lineageKey: lineageKeyRedis,
      proposalId,
      conditionalDeleteKey,
      negativeAuthorizationKeys: this.negativeAuthorization.keysForProposal(proposal),
    });
  }
}
