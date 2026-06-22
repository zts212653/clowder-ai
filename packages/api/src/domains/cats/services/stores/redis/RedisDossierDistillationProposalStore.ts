/**
 * F208 Phase E: Redis-backed DossierDistillationProposalStore.
 *
 * AC-E1: Distillation proposals stored in Redis (TTL=0, Iron Rule #5).
 * KD-17: sourceId idempotency, evidenceRefs fail-closed, baseHash stale-write lock.
 * KD-18: State machine: pending → approved → applied | pending → rejected.
 *
 * Pattern: sorted sets (pending + per-cat indices) + hash (proposal detail)
 * + string (sourceId → proposalId idempotency lookup).
 * Follows project convention (per RedisDossierObservationStore / RedisProfileUpdateProposalStore).
 *
 * Review fix (P1): Lua scripts for atomic CAS transitions + SETNX for sourceId dedup.
 */

import type { CatId, DossierDistillationProposal } from '@cat-cafe/shared';
import { generateProposalId } from '@cat-cafe/shared';
import type { RedisClient } from '@cat-cafe/shared/utils';
import type {
  CreateDistillationProposalInput,
  IDossierDistillationProposalStore,
} from '../ports/DossierDistillationProposalStore.js';
import { DistillationProposalKeys } from '../redis-keys/distillation-proposal-keys.js';

const DEFAULT_LIMIT = 100;

// ---------------------------------------------------------------------------
// Lua scripts for atomic CAS transitions (P1 review fix)
// ioredis auto-prefixes KEYS when keyPrefix is set.
// ---------------------------------------------------------------------------

/** Atomic: check status=pending → set approved + zrem from pending. Returns 1 on success, 0 on CAS fail. */
const LUA_MARK_APPROVED = `
local status = redis.call('HGET', KEYS[1], 'status')
if status ~= 'pending' then return 0 end
redis.call('HSET', KEYS[1], 'status', 'approved', 'approvedBy', ARGV[1], 'approvedAt', ARGV[2])
redis.call('ZREM', KEYS[2], ARGV[3])
return 1
`;

/** Atomic: check status=pending → set rejected + zrem from pending. Returns 1 on success, 0 on CAS fail. */
const LUA_MARK_REJECTED = `
local status = redis.call('HGET', KEYS[1], 'status')
if status ~= 'pending' then return 0 end
redis.call('HSET', KEYS[1], 'status', 'rejected', 'rejectedBy', ARGV[1], 'rejectedAt', ARGV[2])
if ARGV[3] ~= '' then
  redis.call('HSET', KEYS[1], 'rejectionReason', ARGV[3])
end
redis.call('ZREM', KEYS[2], ARGV[4])
return 1
`;

/** Atomic: check status=approved → set applied. Returns 1 on success, 0 on CAS fail. */
const LUA_MARK_APPLIED = `
local status = redis.call('HGET', KEYS[1], 'status')
if status ~= 'approved' then return 0 end
redis.call('HSET', KEYS[1], 'status', 'applied', 'appliedBy', ARGV[1], 'appliedAt', ARGV[2], 'appliedCommitSha', ARGV[3])
return 1
`;

export class RedisDossierDistillationProposalStore implements IDossierDistillationProposalStore {
  private readonly redis: RedisClient;

  constructor(redis: RedisClient) {
    this.redis = redis;
  }

  async create(input: CreateDistillationProposalInput): Promise<DossierDistillationProposal> {
    // KD-17 FM-2: fail-closed — no evidence = no proposal
    if (!input.evidenceRefs || input.evidenceRefs.length === 0) {
      throw new Error('evidenceRefs must be non-empty (KD-17 fail-closed)');
    }

    const proposalId = input.proposalId ?? generateProposalId();

    // P1 fix: atomic sourceId dedup via SETNX — prevents concurrent creates
    // from minting duplicate proposals for the same event.
    const sourceKey = DistillationProposalKeys.sourceIndex(input.sourceId);
    const claimed = await (this.redis as RedisClient & { setnx: (k: string, v: string) => Promise<number> }).setnx(
      sourceKey,
      proposalId,
    );
    if (!claimed) {
      // Another create already claimed this sourceId — return existing proposal
      const existing = await this.getBySourceId(input.sourceId);
      if (existing) return existing;
      // Edge case: sourceIndex exists but proposal missing (partial write from crash)
      throw new Error(`sourceId race: index exists for ${input.sourceId} but proposal missing`);
    }

    const now = Date.now();
    const proposal: DossierDistillationProposal = {
      proposalId,
      status: 'pending',
      sourceEvent: input.sourceEvent,
      sourceId: input.sourceId,
      targetCatId: input.targetCatId,
      targetFields: [...input.targetFields],
      beforeSnapshot: input.beforeSnapshot,
      afterDraft: input.afterDraft,
      rationale: input.rationale,
      evidenceRefs: input.evidenceRefs.map((r) => ({ ...r })),
      baseHash: input.baseHash,
      createdBy: input.createdBy,
      createdAt: now,
    };

    const pipeline = this.redis.multi();
    pipeline.hset(DistillationProposalKeys.detail(proposalId), ...serialize(proposal));
    // TTL=0 — Iron Rule #5
    pipeline.zadd(DistillationProposalKeys.pendingIndex(), String(now), proposalId);
    pipeline.zadd(DistillationProposalKeys.catIndex(input.targetCatId), String(now), proposalId);
    // sourceIndex already set by SETNX above — don't re-SET
    await pipeline.exec();

    return proposal;
  }

  async get(proposalId: string): Promise<DossierDistillationProposal | null> {
    const data = await this.redis.hgetall(DistillationProposalKeys.detail(proposalId));
    if (!data || !data.proposalId) return null;
    return hydrate(data);
  }

  async listPending(limit: number = DEFAULT_LIMIT): Promise<DossierDistillationProposal[]> {
    const ids = await this.redis.zrevrange(DistillationProposalKeys.pendingIndex(), 0, Math.max(0, limit) - 1);
    if (!ids.length) return [];
    return this.hydrateMany(ids);
  }

  async listByCat(catId: CatId, limit: number = DEFAULT_LIMIT): Promise<DossierDistillationProposal[]> {
    const ids = await this.redis.zrevrange(DistillationProposalKeys.catIndex(catId), 0, Math.max(0, limit) - 1);
    if (!ids.length) return [];
    return this.hydrateMany(ids);
  }

  async getBySourceId(sourceId: string): Promise<DossierDistillationProposal | null> {
    const proposalId = await this.redis.get(DistillationProposalKeys.sourceIndex(sourceId));
    if (!proposalId) return null;
    return this.get(proposalId);
  }

  async markApproved(proposalId: string, approvedBy: string): Promise<DossierDistillationProposal | null> {
    const now = Date.now();
    // P1 fix: Lua script for atomic CAS — prevents concurrent approvals
    const result = await (this.redis as RedisClient & { eval: (...args: unknown[]) => Promise<number> }).eval(
      LUA_MARK_APPROVED,
      2, // numkeys
      DistillationProposalKeys.detail(proposalId),
      DistillationProposalKeys.pendingIndex(),
      approvedBy,
      String(now),
      proposalId,
    );
    if (result === 0) return null;

    // Re-read from Redis to return consistent state
    return this.get(proposalId);
  }

  async markRejected(
    proposalId: string,
    rejectedBy: string,
    rejectionReason?: string,
  ): Promise<DossierDistillationProposal | null> {
    const now = Date.now();
    const result = await (this.redis as RedisClient & { eval: (...args: unknown[]) => Promise<number> }).eval(
      LUA_MARK_REJECTED,
      2,
      DistillationProposalKeys.detail(proposalId),
      DistillationProposalKeys.pendingIndex(),
      rejectedBy,
      String(now),
      rejectionReason ?? '',
      proposalId,
    );
    if (result === 0) return null;

    return this.get(proposalId);
  }

  async markApplied(
    proposalId: string,
    appliedBy: string,
    commitSha: string,
  ): Promise<DossierDistillationProposal | null> {
    const now = Date.now();
    const result = await (this.redis as RedisClient & { eval: (...args: unknown[]) => Promise<number> }).eval(
      LUA_MARK_APPLIED,
      1,
      DistillationProposalKeys.detail(proposalId),
      appliedBy,
      String(now),
      commitSha,
    );
    if (result === 0) return null;

    return this.get(proposalId);
  }

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------

  private async hydrateMany(ids: string[]): Promise<DossierDistillationProposal[]> {
    const results: DossierDistillationProposal[] = [];
    for (const id of ids) {
      const proposal = await this.get(id);
      if (proposal) results.push(proposal);
    }
    return results;
  }
}

// ---------------------------------------------------------------------------
// Serialization (flat string pairs for HSET)
// ---------------------------------------------------------------------------

function serialize(p: DossierDistillationProposal): string[] {
  const fields = [
    'proposalId',
    p.proposalId,
    'status',
    p.status,
    'sourceEvent',
    p.sourceEvent,
    'sourceId',
    p.sourceId,
    'targetCatId',
    p.targetCatId,
    'targetFields',
    JSON.stringify(p.targetFields),
    'beforeSnapshot',
    p.beforeSnapshot,
    'afterDraft',
    p.afterDraft,
    'rationale',
    p.rationale,
    'evidenceRefs',
    JSON.stringify(p.evidenceRefs),
    'baseHash',
    p.baseHash,
    'createdBy',
    p.createdBy,
    'createdAt',
    String(p.createdAt),
  ];
  if (p.approvedBy) fields.push('approvedBy', p.approvedBy);
  if (p.approvedAt) fields.push('approvedAt', String(p.approvedAt));
  if (p.rejectedBy) fields.push('rejectedBy', p.rejectedBy);
  if (p.rejectedAt) fields.push('rejectedAt', String(p.rejectedAt));
  if (p.rejectionReason) fields.push('rejectionReason', p.rejectionReason);
  if (p.appliedBy) fields.push('appliedBy', p.appliedBy);
  if (p.appliedAt) fields.push('appliedAt', String(p.appliedAt));
  if (p.appliedCommitSha) fields.push('appliedCommitSha', p.appliedCommitSha);
  return fields;
}

function hydrate(data: Record<string, string>): DossierDistillationProposal {
  return {
    proposalId: data.proposalId,
    status: data.status as DossierDistillationProposal['status'],
    sourceEvent: data.sourceEvent as DossierDistillationProposal['sourceEvent'],
    sourceId: data.sourceId,
    targetCatId: data.targetCatId as DossierDistillationProposal['targetCatId'],
    targetFields: safeParse(data.targetFields, []),
    beforeSnapshot: data.beforeSnapshot || '',
    afterDraft: data.afterDraft || '',
    rationale: data.rationale || '',
    evidenceRefs: safeParse(data.evidenceRefs, []),
    baseHash: data.baseHash || '',
    createdBy: data.createdBy || '',
    createdAt: Number(data.createdAt) || 0,
    ...(data.approvedBy ? { approvedBy: data.approvedBy } : {}),
    ...(data.approvedAt ? { approvedAt: Number(data.approvedAt) } : {}),
    ...(data.rejectedBy ? { rejectedBy: data.rejectedBy } : {}),
    ...(data.rejectedAt ? { rejectedAt: Number(data.rejectedAt) } : {}),
    ...(data.rejectionReason ? { rejectionReason: data.rejectionReason } : {}),
    ...(data.appliedBy ? { appliedBy: data.appliedBy } : {}),
    ...(data.appliedAt ? { appliedAt: Number(data.appliedAt) } : {}),
    ...(data.appliedCommitSha ? { appliedCommitSha: data.appliedCommitSha } : {}),
  };
}

function safeParse<T>(json: string | undefined, fallback: T): T {
  if (!json) return fallback;
  try {
    return JSON.parse(json);
  } catch {
    return fallback;
  }
}
