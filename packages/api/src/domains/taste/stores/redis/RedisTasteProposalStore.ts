/**
 * F221 Phase B: Redis-backed TasteProposal store.
 *
 * Persists taste proposals pending operator approval in the Approval Hub.
 * State machine: pending → approving → approved (two-phase CAS), pending → rejected.
 * Rollback: approving → pending (on vignette writer failure).
 *
 * Iron Law #5 (LL-048): TTL=0 — all proposals and settled history are persistent.
 */

import type {
  ApprovalEnvelope,
  ApprovalPublication,
  TasteDimension,
  TasteProposal,
  TasteProposalStatus,
} from '@cat-cafe/shared';
import { assertApprovalEnvelopeIdentity, generateProposalId } from '@cat-cafe/shared';
import type { RedisClient } from '@cat-cafe/shared/utils';
import type { ApprovalPublicationStore } from '../../../approval-hub/ports/ApprovalPublicationStore.js';
import {
  abortRedisStaged,
  commitRedisApprovalEnvelope,
  hydrateApprovalPublication,
  serializeApprovalPublication,
} from '../../../cats/services/stores/redis/RedisApprovalPublication.js';
import type {
  CreateTasteProposalInput,
  ITasteProposalStore,
  TasteWriteCheckpoint,
} from '../ports/TasteProposalStore.js';
import { TasteProposalKeys } from '../redis-keys/taste-proposal-keys.js';

/** CAS: pending → approving (claim for approval). */
const CAS_CLAIM_LUA = `
  local key = KEYS[1]
  local status = redis.call('HGET', key, 'status')
  if status ~= 'pending' then return 0 end
  redis.call('HSET', key, 'status', 'approving')
  return 1
`;

/** Persist durable writer output without settling the proposal. */
const CAS_CHECKPOINT_LUA = `
  local key = KEYS[1]
  local status = redis.call('HGET', key, 'status')
  if status ~= 'approving' then return 0 end
  redis.call('HSET', key,
    'vignetteSlug', ARGV[1],
    'vignettePath', ARGV[2])
  return 1
`;

/** CAS: approving → approved (finalize after vignette write). */
const CAS_FINALIZE_LUA = `
  local key = KEYS[1]
  local pendingKey = KEYS[2]
  local settledKey = KEYS[3]
  local status = redis.call('HGET', key, 'status')
  if status ~= 'approving' then return 0 end
  redis.call('HSET', key, 'status', 'approved',
    'approvedBy', ARGV[1],
    'approvedAt', ARGV[2],
    'vignetteSlug', ARGV[4],
    'vignettePath', ARGV[5])
  redis.call('ZREM', pendingKey, ARGV[3])
  redis.call('ZADD', settledKey, ARGV[2], ARGV[3])
  return 1
`;

/** CAS: approving → pending (rollback on writer failure). */
const CAS_ROLLBACK_LUA = `
  local key = KEYS[1]
  local status = redis.call('HGET', key, 'status')
  if status ~= 'approving' then return 0 end
  redis.call('HSET', key, 'status', 'pending')
  redis.call('HDEL', key, 'approvedBy', 'vignetteSlug', 'vignettePath')
  return 1
`;

/** CAS: pending → rejected. */
const CAS_REJECT_LUA = `
  local key = KEYS[1]
  local pendingKey = KEYS[2]
  local settledKey = KEYS[3]
  local status = redis.call('HGET', key, 'status')
  if status ~= 'pending' then return 0 end
  redis.call('HSET', key, 'status', 'rejected',
    'rejectedBy', ARGV[1],
    'rejectedAt', ARGV[2],
    'rejectionReason', ARGV[4])
  redis.call('ZREM', pendingKey, ARGV[3])
  redis.call('ZADD', settledKey, ARGV[2], ARGV[3])
  return 1
`;

/**
 * Atomically persist a staged proposal and promote its bounded reservation to
 * a durable retry identity. The reservation fence prevents a delayed creator
 * from publishing after another request has acquired the same client key.
 */
const CREATE_WITH_DEDUP_LUA = `
  if redis.call('GET', KEYS[3]) ~= ARGV[1] then return 0 end
  redis.call('HSET', KEYS[1], unpack(ARGV, 4))
  redis.call('ZADD', KEYS[2], ARGV[2], ARGV[3])
  redis.call('PERSIST', KEYS[3])
  return 1
`;

export class RedisTasteProposalStore implements ITasteProposalStore, ApprovalPublicationStore {
  private redis: RedisClient;

  constructor(redis: RedisClient) {
    this.redis = redis;
  }

  async create(input: CreateTasteProposalInput): Promise<TasteProposal> {
    const id = input.proposalId ?? generateProposalId();
    const now = Date.now();
    const proposal: TasteProposal = {
      id,
      userId: input.userId,
      catId: input.catId,
      threadId: input.threadId,
      sourceMessageId: input.sourceMessageId,
      scene: input.scene,
      quote: input.quote,
      tags: [...input.tags],
      dimension: input.dimension as TasteDimension,
      privacy: input.privacy as 'public' | 'sensitive',
      status: 'pending',
      createdAt: now,
      clientRequestId: input.clientRequestId,
      approvalOriginRef: input.approvalOriginRef,
      publication: { state: 'staged', stagedAt: now },
    };

    const key = TasteProposalKeys.detail(id);
    const pendingKey = TasteProposalKeys.userPending(input.userId);

    if (input.clientRequestId) {
      const created = await this.redis.eval(
        CREATE_WITH_DEDUP_LUA,
        3,
        key,
        pendingKey,
        TasteProposalKeys.dedup(input.userId, input.clientRequestId),
        id,
        String(now),
        id,
        ...serializeProposal(proposal),
      );
      if (created !== 1) {
        throw new Error(`taste proposal dedup reservation lost before create: ${id}`);
      }
      return proposal;
    }

    const pipeline = this.redis.multi();
    pipeline.hset(key, ...serializeProposal(proposal));
    pipeline.zadd(pendingKey, now, id);
    await pipeline.exec();

    return proposal;
  }

  async get(id: string): Promise<TasteProposal | null> {
    const raw = await this.redis.hgetall(TasteProposalKeys.detail(id));
    if (!raw || Object.keys(raw).length === 0) return null;
    return hydrateProposal(raw);
  }

  async listPending(userId: string): Promise<TasteProposal[]> {
    const pendingKey = TasteProposalKeys.userPending(userId);
    const ids = await this.redis.zrevrange(pendingKey, 0, 99);
    if (!ids.length) return [];
    return this.batchGet(ids, (p) => p.status === 'pending');
  }

  async listActionable(userId: string): Promise<TasteProposal[]> {
    const pendingKey = TasteProposalKeys.userPending(userId);
    const ids = await this.redis.zrevrange(pendingKey, 0, 99);
    if (!ids.length) return [];
    return this.batchGet(ids, (p) => p.status === 'pending' || p.status === 'approving');
  }

  async listSettledByUser(userId: string, limit = 50): Promise<TasteProposal[]> {
    const settledKey = TasteProposalKeys.userSettled(userId);
    const ids = await this.redis.zrevrange(settledKey, 0, limit - 1);
    if (!ids.length) return [];
    return this.batchGet(ids);
  }

  async claimForApproval(id: string, _userId: string): Promise<TasteProposal | null> {
    const proposal = await this.get(id);
    if (!proposal) return null;

    const key = TasteProposalKeys.detail(id);
    const result = await this.redis.eval(CAS_CLAIM_LUA, 1, key);
    if (result === 0) return null;

    return { ...proposal, status: 'approving' };
  }

  async recordWriteCheckpoint(id: string, checkpoint: TasteWriteCheckpoint): Promise<TasteProposal | null> {
    const proposal = await this.get(id);
    if (!proposal) return null;
    const result = await this.redis.eval(
      CAS_CHECKPOINT_LUA,
      1,
      TasteProposalKeys.detail(id),
      checkpoint.vignetteSlug,
      checkpoint.vignettePath,
    );
    if (result === 0) return null;
    return { ...proposal, ...checkpoint };
  }

  async finalizeApproval(
    id: string,
    userId: string,
    vignetteSlug: string,
    vignettePath: string,
  ): Promise<TasteProposal | null> {
    const proposal = await this.get(id);
    if (!proposal) return null;

    const key = TasteProposalKeys.detail(id);
    const pendingKey = TasteProposalKeys.userPending(proposal.userId);
    const settledKey = TasteProposalKeys.userSettled(proposal.userId);
    const now = Date.now();

    const result = await this.redis.eval(
      CAS_FINALIZE_LUA,
      3,
      key,
      pendingKey,
      settledKey,
      userId,
      String(now),
      id,
      vignetteSlug,
      vignettePath,
    );
    if (result === 0) return null;

    return {
      ...proposal,
      status: 'approved',
      approvedBy: userId,
      approvedAt: now,
      vignetteSlug,
      vignettePath,
    };
  }

  async rollbackClaim(id: string): Promise<boolean> {
    const key = TasteProposalKeys.detail(id);
    const result = await this.redis.eval(CAS_ROLLBACK_LUA, 1, key);
    return result === 1;
  }

  async markRejected(id: string, reason: string, userId: string): Promise<TasteProposal | null> {
    const proposal = await this.get(id);
    if (!proposal) return null;

    const key = TasteProposalKeys.detail(id);
    const pendingKey = TasteProposalKeys.userPending(proposal.userId);
    const settledKey = TasteProposalKeys.userSettled(proposal.userId);
    const now = Date.now();

    const result = await this.redis.eval(
      CAS_REJECT_LUA,
      3,
      key,
      pendingKey,
      settledKey,
      userId,
      String(now),
      id,
      reason,
    );
    if (result === 0) return null;

    return { ...proposal, status: 'rejected', rejectedBy: userId, rejectedAt: now, rejectionReason: reason };
  }

  async getDedupProposalId(userId: string, clientRequestId: string): Promise<string | null> {
    const key = TasteProposalKeys.dedup(userId, clientRequestId);
    return this.redis.get(key);
  }

  async reserveDedup(userId: string, clientRequestId: string, proposalId: string): Promise<string> {
    const key = TasteProposalKeys.dedup(userId, clientRequestId);
    // The bounded reservation protects the pre-create crash window. create()
    // atomically promotes the winning mapping to TTL=0 with the proposal write.
    const result = await this.redis.set(key, proposalId, 'EX', 300, 'NX');
    if (result === 'OK') return proposalId;
    // Someone else won the race — return their ID
    const existing = await this.redis.get(key);
    return existing ?? proposalId;
  }

  async releaseDedup(userId: string, clientRequestId: string, expectedProposalId: string): Promise<void> {
    const key = TasteProposalKeys.dedup(userId, clientRequestId);
    // Release only an unmaterialized reservation. If create() committed but its
    // acknowledgement was lost, the durable proposal keeps the retry identity.
    await this.redis.eval(
      `if redis.call('GET', KEYS[1]) == ARGV[1] and redis.call('EXISTS', KEYS[2]) == 0 then
        return redis.call('DEL', KEYS[1])
      end
      return 0`,
      2,
      key,
      TasteProposalKeys.detail(expectedProposalId),
      expectedProposalId,
    );
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
      canonicalProposalId: proposal.id,
      sourceFeatureId: 'F221',
      ownerUserId: proposal.userId,
      requesterCatId: proposal.catId,
      createdAt: proposal.createdAt,
    });
    await commitRedisApprovalEnvelope(this.redis, TasteProposalKeys.detail(proposalId), envelope);
  }

  async abortStaged(proposalId: string, _reason: string): Promise<void> {
    const proposal = await this.get(proposalId);
    if (!proposal) return;
    await abortRedisStaged(
      this.redis,
      TasteProposalKeys.detail(proposalId),
      [TasteProposalKeys.userPending(proposal.userId)],
      proposalId,
      proposal.clientRequestId ? TasteProposalKeys.dedup(proposal.userId, proposal.clientRequestId) : undefined,
    );
  }

  private async batchGet(ids: string[], filter?: (p: TasteProposal) => boolean): Promise<TasteProposal[]> {
    const pipeline = this.redis.pipeline();
    for (const id of ids) {
      pipeline.hgetall(TasteProposalKeys.detail(id));
    }
    const results = await pipeline.exec();
    if (!results) return [];

    const proposals: TasteProposal[] = [];
    for (const [err, raw] of results) {
      if (err || !raw || typeof raw !== 'object' || Object.keys(raw as Record<string, string>).length === 0) continue;
      const p = hydrateProposal(raw as Record<string, string>);
      if (!filter || filter(p)) proposals.push(p);
    }
    return proposals;
  }
}

// ---- Serialize / Hydrate ----

function serializeProposal(p: TasteProposal): string[] {
  const fields: string[] = [
    'id',
    p.id,
    'userId',
    p.userId,
    'catId',
    p.catId,
    'threadId',
    p.threadId,
    'scene',
    p.scene,
    'quote',
    p.quote,
    'tags',
    JSON.stringify(p.tags),
    'dimension',
    p.dimension,
    'privacy',
    p.privacy,
    'status',
    p.status,
    'createdAt',
    String(p.createdAt),
  ];
  if (p.sourceMessageId) fields.push('sourceMessageId', p.sourceMessageId);
  if (p.clientRequestId) fields.push('clientRequestId', p.clientRequestId);
  if (p.approvalOriginRef) fields.push('approvalOriginRef', JSON.stringify(p.approvalOriginRef));
  if (p.approvedBy) fields.push('approvedBy', p.approvedBy);
  if (p.approvedAt) fields.push('approvedAt', String(p.approvedAt));
  if (p.rejectedBy) fields.push('rejectedBy', p.rejectedBy);
  if (p.rejectedAt) fields.push('rejectedAt', String(p.rejectedAt));
  if (p.rejectionReason) fields.push('rejectionReason', p.rejectionReason);
  if (p.vignetteSlug) fields.push('vignetteSlug', p.vignetteSlug);
  if (p.vignettePath) fields.push('vignettePath', p.vignettePath);
  if (p.publication) fields.push('publication', serializeApprovalPublication(p.publication));
  return fields;
}

function hydrateProposal(raw: Record<string, string>): TasteProposal {
  return {
    id: raw.id,
    userId: raw.userId,
    catId: raw.catId,
    threadId: raw.threadId,
    scene: raw.scene,
    quote: raw.quote,
    tags: JSON.parse(raw.tags || '[]'),
    dimension: raw.dimension as TasteDimension,
    privacy: raw.privacy as 'public' | 'sensitive',
    status: raw.status as TasteProposalStatus,
    createdAt: Number(raw.createdAt),
    ...(raw.sourceMessageId ? { sourceMessageId: raw.sourceMessageId } : {}),
    ...(raw.clientRequestId ? { clientRequestId: raw.clientRequestId } : {}),
    ...(raw.approvalOriginRef ? { approvalOriginRef: JSON.parse(raw.approvalOriginRef) } : {}),
    ...(raw.approvedBy ? { approvedBy: raw.approvedBy } : {}),
    ...(raw.approvedAt ? { approvedAt: Number(raw.approvedAt) } : {}),
    ...(raw.rejectedBy ? { rejectedBy: raw.rejectedBy } : {}),
    ...(raw.rejectedAt ? { rejectedAt: Number(raw.rejectedAt) } : {}),
    ...(raw.rejectionReason ? { rejectionReason: raw.rejectionReason } : {}),
    ...(raw.vignetteSlug ? { vignetteSlug: raw.vignetteSlug } : {}),
    ...(raw.vignettePath ? { vignettePath: raw.vignettePath } : {}),
    ...(raw.publication ? { publication: hydrateApprovalPublication(raw.publication) } : {}),
  };
}
