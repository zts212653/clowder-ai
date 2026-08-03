/**
 * F260 Phase A: Redis-backed EntityProposal store.
 *
 * Persists entity proposals pending operator approval in the Approval Hub.
 * Lifecycle: create(pending) → approve/reject(terminal, one-shot).
 *
 * Iron Law #5 (LL-048): TTL=0 — all proposals and settled history are persistent.
 * User-visible in Hub via F260ApprovalAdapter; process restart must not drop state.
 */

import type {
  ApprovalEnvelope,
  ApprovalPublication,
  EntityProposal,
  EntityProposalProvenance,
  EntityStance,
  EntityVisibilityScope,
} from '@cat-cafe/shared';
import type { RedisClient } from '@cat-cafe/shared/utils';
import {
  hydrateApprovalPublication,
  serializeApprovalPublication,
} from '../../../cats/services/stores/redis/RedisApprovalPublication.js';
import { EntityProposalKeys } from '../../../cats/services/stores/redis-keys/proposals/entity-proposal-keys.js';
import type { ApprovalPublicationStore } from '../../ports/ApprovalPublicationStore.js';
import type { CreateEntityProposalInput, IEntityProposalStore } from '../ports/IEntityProposalStore.js';
import { RedisEntityProposalPublicationStore } from './RedisEntityProposalPublicationStore.js';

/** CAS transition: pending → approved. Atomic: check status + update fields + move index. */
const CAS_APPROVE_LUA = `
  local key = KEYS[1]
  local pendingKey = KEYS[2]
  local settledKey = KEYS[3]
  local status = redis.call('HGET', key, 'status')
  if status ~= 'pending' then return 0 end
  redis.call('HSET', key, 'status', 'approved',
    'approvedBy', ARGV[1],
    'approvedAt', ARGV[2])
  redis.call('ZREM', pendingKey, ARGV[3])
  redis.call('ZADD', settledKey, ARGV[2], ARGV[3])
  return 1
`;

/**
 * CAS rollback: approved → pending (used when post-approve upsert fails).
 * Moves proposal back from settled to pending index.
 */
const CAS_REVERT_PENDING_LUA = `
  local key = KEYS[1]
  local pendingKey = KEYS[2]
  local settledKey = KEYS[3]
  local status = redis.call('HGET', key, 'status')
  if status ~= 'approved' then return 0 end
  redis.call('HSET', key, 'status', 'pending')
  redis.call('HDEL', key, 'approvedBy', 'approvedAt')
  local createdAt = redis.call('HGET', key, 'createdAt')
  redis.call('ZREM', settledKey, ARGV[1])
  redis.call('ZADD', pendingKey, createdAt, ARGV[1])
  return 1
`;

/** CAS transition: pending → rejected. */
const CAS_REJECT_LUA = `
  local key = KEYS[1]
  local pendingKey = KEYS[2]
  local settledKey = KEYS[3]
  local status = redis.call('HGET', key, 'status')
  if status ~= 'pending' then return 0 end
  redis.call('HSET', key, 'status', 'rejected',
    'rejectedBy', ARGV[1],
    'rejectedAt', ARGV[2])
  if ARGV[4] ~= '' then
    redis.call('HSET', key, 'rejectionReason', ARGV[4])
  end
  redis.call('ZREM', pendingKey, ARGV[3])
  redis.call('ZADD', settledKey, ARGV[2], ARGV[3])
  return 1
`;

export class RedisEntityProposalStore implements IEntityProposalStore, ApprovalPublicationStore {
  private readonly publicationStore: RedisEntityProposalPublicationStore;

  constructor(private readonly redis: RedisClient) {
    this.publicationStore = new RedisEntityProposalPublicationStore(redis, (proposalId) => this.get(proposalId));
  }

  async create(input: CreateEntityProposalInput): Promise<EntityProposal> {
    const proposalId = input.proposalId ?? `ep-${await this.redis.incr(EntityProposalKeys.counter())}`;
    const now = Date.now();
    const proposal: EntityProposal = {
      proposalId,
      status: 'pending',
      entityId: input.entityId,
      entityType: input.entityType as EntityProposal['entityType'],
      canonicalName: input.canonicalName,
      aliases: [...input.aliases],
      stance: input.stance,
      visibilityScope: input.visibilityScope,
      provenance: input.provenance.map((p) => ({ ...p })),
      rationale: input.rationale,
      sourceThreadId: input.sourceThreadId,
      sourceCatId: input.sourceCatId,
      ownerUserId: input.ownerUserId,
      clientRequestId: input.clientRequestId,
      approvalOriginRef: input.approvalOriginRef,
      createdAt: now,
      publication: { state: 'staged', stagedAt: now },
    };

    const key = EntityProposalKeys.detail(proposalId);
    const pendingKey = EntityProposalKeys.userPending(input.ownerUserId);

    if (input.clientRequestId) {
      await this.publicationStore.persistStagedProposal({
        proposalId,
        ownerUserId: input.ownerUserId,
        clientRequestId: input.clientRequestId,
        createdAt: now,
        serializedFields: serializeProposal(proposal),
      });
      return proposal;
    }

    const pipeline = this.redis.multi();
    pipeline.hset(key, ...serializeProposal(proposal));
    pipeline.zadd(pendingKey, now, proposalId);
    await pipeline.exec();

    return proposal;
  }

  async get(proposalId: string): Promise<EntityProposal | null> {
    const key = EntityProposalKeys.detail(proposalId);
    const raw = await this.redis.hgetall(key);
    if (!raw || Object.keys(raw).length === 0) return null;
    return hydrateProposal(raw);
  }

  async listPending(userId: string, limit = 100): Promise<EntityProposal[]> {
    const pendingKey = EntityProposalKeys.userPending(userId);
    const ids = await this.redis.zrevrange(pendingKey, 0, limit - 1);
    if (!ids.length) return [];
    return this.batchGet(ids, (p) => p.status === 'pending');
  }

  async listSettledByUser(userId: string, limit = 100): Promise<EntityProposal[]> {
    const settledKey = EntityProposalKeys.userSettled(userId);
    const ids = await this.redis.zrevrange(settledKey, 0, limit - 1);
    if (!ids.length) return [];
    return this.batchGet(ids);
  }

  async markApproved(proposalId: string, approvedBy: string): Promise<EntityProposal | null> {
    const proposal = await this.get(proposalId);
    if (!proposal) return null;

    const key = EntityProposalKeys.detail(proposalId);
    const pendingKey = EntityProposalKeys.userPending(proposal.ownerUserId);
    const settledKey = EntityProposalKeys.userSettled(proposal.ownerUserId);
    const now = Date.now();

    const result = await this.redis.eval(
      CAS_APPROVE_LUA,
      3,
      key,
      pendingKey,
      settledKey,
      approvedBy,
      String(now),
      proposalId,
    );
    if (result === 0) return null;

    return { ...proposal, status: 'approved', approvedBy, approvedAt: now };
  }

  async markRejected(proposalId: string, rejectedBy: string, rejectionReason?: string): Promise<EntityProposal | null> {
    const proposal = await this.get(proposalId);
    if (!proposal) return null;

    const key = EntityProposalKeys.detail(proposalId);
    const pendingKey = EntityProposalKeys.userPending(proposal.ownerUserId);
    const settledKey = EntityProposalKeys.userSettled(proposal.ownerUserId);
    const now = Date.now();

    const result = await this.redis.eval(
      CAS_REJECT_LUA,
      3,
      key,
      pendingKey,
      settledKey,
      rejectedBy,
      String(now),
      proposalId,
      rejectionReason ?? '',
    );
    if (result === 0) return null;

    return {
      ...proposal,
      status: 'rejected',
      rejectedBy,
      rejectedAt: now,
      ...(rejectionReason ? { rejectionReason } : {}),
    };
  }

  async revertToPending(proposalId: string): Promise<boolean> {
    const proposal = await this.get(proposalId);
    if (!proposal) return false;

    const key = EntityProposalKeys.detail(proposalId);
    const pendingKey = EntityProposalKeys.userPending(proposal.ownerUserId);
    const settledKey = EntityProposalKeys.userSettled(proposal.ownerUserId);

    const result = await this.redis.eval(CAS_REVERT_PENDING_LUA, 3, key, pendingKey, settledKey, proposalId);
    return result === 1;
  }

  // ---------------------------------------------------------------------------
  // ApprovalPublicationStore (Phase-I publication envelope)
  // ---------------------------------------------------------------------------

  async getPublication(proposalId: string): Promise<ApprovalPublication | null> {
    return this.publicationStore.getPublication(proposalId);
  }

  async commitEnvelope(proposalId: string, envelope: ApprovalEnvelope): Promise<void> {
    return this.publicationStore.commitEnvelope(proposalId, envelope);
  }

  async abortStaged(proposalId: string, reason: string): Promise<void> {
    return this.publicationStore.abortStaged(proposalId, reason);
  }

  // ---------------------------------------------------------------------------
  // Idempotency (R4 P1-1: explicit clientRequestId dedup — mirrors F221 pattern)
  // ---------------------------------------------------------------------------

  async getDedupProposalId(userId: string, clientRequestId: string): Promise<string | null> {
    return this.publicationStore.getDedupProposalId(userId, clientRequestId);
  }

  async reserveDedup(userId: string, clientRequestId: string, proposalId: string): Promise<string> {
    return this.publicationStore.reserveDedup(userId, clientRequestId, proposalId);
  }

  async releaseDedup(userId: string, clientRequestId: string, expectedProposalId: string): Promise<void> {
    return this.publicationStore.releaseDedup(userId, clientRequestId, expectedProposalId);
  }

  private async batchGet(ids: string[], filter?: (p: EntityProposal) => boolean): Promise<EntityProposal[]> {
    const pipeline = this.redis.pipeline();
    for (const id of ids) {
      pipeline.hgetall(EntityProposalKeys.detail(id));
    }
    const results = await pipeline.exec();
    if (!results) return [];

    const proposals: EntityProposal[] = [];
    for (const [err, raw] of results) {
      if (err || !raw || typeof raw !== 'object' || Object.keys(raw as Record<string, string>).length === 0) continue;
      const p = hydrateProposal(raw as Record<string, string>);
      if (!filter || filter(p)) proposals.push(p);
    }
    return proposals;
  }
}

// ---- Serialize / Hydrate ----

function serializeProposal(p: EntityProposal): string[] {
  const fields: string[] = [
    'proposalId',
    p.proposalId,
    'status',
    p.status,
    'entityId',
    p.entityId,
    'entityType',
    p.entityType,
    'canonicalName',
    p.canonicalName,
    'aliases',
    JSON.stringify(p.aliases),
    'stance',
    p.stance,
    'visibilityScope',
    p.visibilityScope,
    'provenance',
    JSON.stringify(p.provenance),
    'rationale',
    p.rationale,
    'sourceThreadId',
    p.sourceThreadId,
    'sourceCatId',
    p.sourceCatId,
    'ownerUserId',
    p.ownerUserId,
    'createdAt',
    String(p.createdAt),
  ];
  if (p.approvedBy) fields.push('approvedBy', p.approvedBy);
  if (p.approvedAt) fields.push('approvedAt', String(p.approvedAt));
  if (p.rejectedBy) fields.push('rejectedBy', p.rejectedBy);
  if (p.rejectedAt) fields.push('rejectedAt', String(p.rejectedAt));
  if (p.rejectionReason) fields.push('rejectionReason', p.rejectionReason);
  if (p.clientRequestId) fields.push('clientRequestId', p.clientRequestId);
  if (p.approvalOriginRef) fields.push('approvalOriginRef', JSON.stringify(p.approvalOriginRef));
  if (p.publication) fields.push('publication', serializeApprovalPublication(p.publication));
  return fields;
}

function hydrateProposal(raw: Record<string, string>): EntityProposal {
  return {
    proposalId: raw.proposalId,
    status: raw.status as EntityProposal['status'],
    entityId: raw.entityId,
    entityType: raw.entityType as EntityProposal['entityType'],
    canonicalName: raw.canonicalName,
    aliases: JSON.parse(raw.aliases || '[]'),
    stance: raw.stance as EntityStance,
    visibilityScope: raw.visibilityScope as EntityVisibilityScope,
    provenance: JSON.parse(raw.provenance || '[]') as EntityProposalProvenance[],
    rationale: raw.rationale,
    sourceThreadId: raw.sourceThreadId,
    sourceCatId: raw.sourceCatId,
    ownerUserId: raw.ownerUserId,
    ...(raw.clientRequestId ? { clientRequestId: raw.clientRequestId } : {}),
    ...(raw.approvalOriginRef ? { approvalOriginRef: JSON.parse(raw.approvalOriginRef) } : {}),
    createdAt: Number(raw.createdAt),
    ...(raw.approvedBy ? { approvedBy: raw.approvedBy } : {}),
    ...(raw.approvedAt ? { approvedAt: Number(raw.approvedAt) } : {}),
    ...(raw.rejectedBy ? { rejectedBy: raw.rejectedBy } : {}),
    ...(raw.rejectedAt ? { rejectedAt: Number(raw.rejectedAt) } : {}),
    ...(raw.rejectionReason ? { rejectionReason: raw.rejectionReason } : {}),
    ...(raw.publication ? { publication: hydrateApprovalPublication(raw.publication) } : {}),
  };
}
