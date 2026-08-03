/**
 * Redis-backed F231 Phase C ProfileUpdateProposal store.
 *
 * Mirrors RedisProposalStore (F128): Hash profile-update:{id} + SortedSet pending/thread
 * + CAS Lua transitions + dedup String (short TTL). Reuses the generic Lua from
 * RedisProposalStoreHelpers (CAS_TRANSITION / RECORD_CREATED_THREAD / RELEASE_DEDUP).
 *
 * Iron law #5 (LL-048): proposal hashes carry approval-card UI state + audit lineage →
 * persistent (TTL=0) unless the caller explicitly opts in. Only the dedup key has a TTL.
 *
 * P1-1 crash recovery: recordCheckpoint persists writtenPath/provenancePath via a
 * conditional HSET (only while status='approving'); the route checkpoints each path
 * separately so a crash between primer-write and provenance-write is recoverable.
 */

import type {
  ApprovalEnvelope,
  ApprovalPublication,
  ProfileUpdateProposal,
  ProfileUpdateProposalStatus,
} from '@cat-cafe/shared';
import { assertApprovalEnvelopeIdentity, generateProposalId } from '@cat-cafe/shared';
import type { RedisClient } from '@cat-cafe/shared/utils';
import type {
  CreateProfileUpdateProposalInput,
  IProfileUpdateProposalStore,
  ProfileUpdateCheckpoint,
} from '../ports/ProfileUpdateProposalStore.js';
import { ProfileUpdateProposalKeys } from '../redis-keys/proposals/profile-update-proposal-keys.js';
import { abortRedisStaged, commitRedisApprovalEnvelope } from './RedisApprovalPublication.js';
import { hydrateProfileUpdateProposal, serializeProfileUpdateProposal } from './RedisProfileUpdateProposalCodec.js';
import { CAS_TRANSITION_LUA, RECORD_CREATED_THREAD_LUA, RELEASE_DEDUP_LUA } from './RedisProposalStoreHelpers.js';
import { CAS_FINALIZE_AND_SETTLE_LUA, CAS_REJECT_AND_SETTLE_LUA } from './redis-profile-update-lua-scripts.js';

const DEFAULT_DEDUP_TTL_SECONDS = 10 * 60;
const DEFAULT_LIST_LIMIT = 100;

export class RedisProfileUpdateProposalStore implements IProfileUpdateProposalStore {
  private readonly redis: RedisClient;
  private readonly ttlSeconds: number | null;
  private readonly dedupTtlSeconds: number;

  constructor(redis: RedisClient, options?: { ttlSeconds?: number; dedupTtlSeconds?: number }) {
    this.redis = redis;
    const ttl = options?.ttlSeconds;
    this.ttlSeconds = ttl !== undefined && Number.isFinite(ttl) && ttl > 0 ? Math.floor(ttl) : null;
    this.dedupTtlSeconds = options?.dedupTtlSeconds ?? DEFAULT_DEDUP_TTL_SECONDS;
  }

  async create(input: CreateProfileUpdateProposalInput): Promise<ProfileUpdateProposal> {
    const now = Date.now();
    const proposal: ProfileUpdateProposal = {
      proposalId: input.proposalId ?? generateProposalId(),
      status: 'pending',
      sourceThreadId: input.sourceThreadId,
      sourceInvocationId: input.sourceInvocationId,
      sourceCatId: input.sourceCatId,
      targetLayer: input.targetLayer,
      targetPath: input.targetPath,
      beforeContent: input.beforeContent,
      baseContentHash: input.baseContentHash,
      afterContent: input.afterContent,
      rationale: input.rationale,
      signalProvenance: { ...input.signalProvenance },
      createdBy: input.createdBy,
      createdAt: now,
      publication: { state: 'staged', stagedAt: now },
    };
    const key = ProfileUpdateProposalKeys.detail(proposal.proposalId);
    const pipeline = this.redis.multi();
    pipeline.hset(key, ...serializeProfileUpdateProposal(proposal));
    if (this.ttlSeconds) pipeline.expire(key, this.ttlSeconds);
    pipeline.zadd(ProfileUpdateProposalKeys.userPending(proposal.createdBy), String(now), proposal.proposalId);
    pipeline.zadd(ProfileUpdateProposalKeys.threadList(proposal.sourceThreadId), String(now), proposal.proposalId);
    await pipeline.exec();
    return proposal;
  }

  async get(proposalId: string): Promise<ProfileUpdateProposal | null> {
    const data = await this.redis.hgetall(ProfileUpdateProposalKeys.detail(proposalId));
    if (!data || !data.proposalId) return null;
    return hydrateProfileUpdateProposal(data);
  }

  async listPending(userId: string, limit: number = DEFAULT_LIST_LIMIT): Promise<ProfileUpdateProposal[]> {
    return this.loadFromIndex(ProfileUpdateProposalKeys.userPending(userId), limit);
  }

  async listByThread(threadId: string, limit: number = DEFAULT_LIST_LIMIT): Promise<ProfileUpdateProposal[]> {
    return this.loadFromIndex(ProfileUpdateProposalKeys.threadList(threadId), limit);
  }

  /** F246 Phase H: list settled (approved/rejected) proposals for a user, newest first. */
  async listSettledByUser(userId: string, limit: number = DEFAULT_LIST_LIMIT): Promise<ProfileUpdateProposal[]> {
    return this.loadFromIndex(ProfileUpdateProposalKeys.userSettled(userId), limit);
  }

  async claimForApproval(proposalId: string, approvedBy: string): Promise<ProfileUpdateProposal | null> {
    const proposal = await this.get(proposalId);
    if (!proposal || proposal.status !== 'pending') return null;
    const claimedAt = Date.now();
    const ok = await this.cas(proposalId, proposal.createdBy, 'pending', 'zrem', '', [
      'status',
      'approving',
      'approvedBy',
      approvedBy,
      'claimedAt',
      String(claimedAt),
    ]);
    if (!ok) return null;
    return { ...proposal, status: 'approving', approvedBy, claimedAt };
  }

  async recordCheckpoint(
    proposalId: string,
    checkpoint: ProfileUpdateCheckpoint,
  ): Promise<ProfileUpdateProposal | null> {
    const fields: string[] = [];
    if (checkpoint.writtenPath !== undefined) fields.push('writtenPath', checkpoint.writtenPath);
    if (checkpoint.provenancePath !== undefined) fields.push('provenancePath', checkpoint.provenancePath);
    if (fields.length > 0) {
      // conditional HSET only while status='approving' (generic RECORD_CREATED_THREAD_LUA)
      await this.redis.eval(RECORD_CREATED_THREAD_LUA, 1, ProfileUpdateProposalKeys.detail(proposalId), ...fields);
    }
    const updated = await this.get(proposalId);
    return updated && updated.status === 'approving' ? updated : null;
  }

  async finalizeApproval(proposalId: string): Promise<ProfileUpdateProposal | null> {
    const proposal = await this.get(proposalId);
    if (!proposal || proposal.status !== 'approving') return null;
    const now = Date.now();
    // F246 Phase H: use atomic Lua to update hash AND add to settled index in one call.
    const result = await this.redis.eval(
      CAS_FINALIZE_AND_SETTLE_LUA,
      2,
      ProfileUpdateProposalKeys.detail(proposalId),
      ProfileUpdateProposalKeys.userSettled(proposal.createdBy),
      'approving',
      proposalId,
      String(now),
    );
    if (result !== 1) return null;
    const { claimedAt: _claimedAt, ...rest } = proposal;
    return { ...rest, status: 'approved', approvedAt: now };
  }

  async rollbackClaim(proposalId: string): Promise<boolean> {
    const proposal = await this.get(proposalId);
    if (!proposal || proposal.status !== 'approving') return false;
    return this.cas(proposalId, proposal.createdBy, 'approving', 'zadd', String(proposal.createdAt), [
      'status',
      'pending',
      'approvedBy',
      '',
      'claimedAt',
      '0',
    ]);
  }

  async markRejected(
    proposalId: string,
    rejectedBy: string,
    rejectionReason?: string,
  ): Promise<ProfileUpdateProposal | null> {
    const proposal = await this.get(proposalId);
    if (!proposal || proposal.status !== 'pending') return null;
    const now = Date.now();
    // F246 Phase H: use atomic Lua to ZREM pending, HSET hash, ZADD settled in one call.
    const result = await this.redis.eval(
      CAS_REJECT_AND_SETTLE_LUA,
      3,
      ProfileUpdateProposalKeys.detail(proposalId),
      ProfileUpdateProposalKeys.userPending(proposal.createdBy),
      ProfileUpdateProposalKeys.userSettled(proposal.createdBy),
      'pending',
      proposalId,
      String(now),
      rejectedBy,
      rejectionReason ?? '',
    );
    if (result !== 1) return null;
    return {
      ...proposal,
      status: 'rejected',
      rejectedBy,
      rejectedAt: now,
      ...(rejectionReason ? { rejectionReason } : {}),
    };
  }

  async getDedupProposalId(userId: string, clientRequestId: string): Promise<string | null> {
    return (await this.redis.get(ProfileUpdateProposalKeys.dedup(userId, clientRequestId))) ?? null;
  }

  async reserveDedup(userId: string, clientRequestId: string, proposalId: string): Promise<string> {
    const key = ProfileUpdateProposalKeys.dedup(userId, clientRequestId);
    const ok = await this.redis.set(key, proposalId, 'EX', this.dedupTtlSeconds, 'NX');
    if (ok === 'OK') return proposalId;
    return (await this.redis.get(key)) ?? proposalId;
  }

  async releaseDedup(userId: string, clientRequestId: string, expectedProposalId: string): Promise<void> {
    await this.redis.eval(
      RELEASE_DEDUP_LUA,
      1,
      ProfileUpdateProposalKeys.dedup(userId, clientRequestId),
      expectedProposalId,
    );
  }

  async setCardMessageId(proposalId: string, cardMessageId: string): Promise<void> {
    await this.redis.hset(ProfileUpdateProposalKeys.detail(proposalId), 'cardMessageId', cardMessageId);
  }

  async getPublication(proposalId: string): Promise<ApprovalPublication | null> {
    return (await this.get(proposalId))?.publication ?? null;
  }

  async commitEnvelope(proposalId: string, envelope: ApprovalEnvelope): Promise<void> {
    const proposal = await this.get(proposalId);
    if (!proposal) throw new Error(`proposal not found: ${proposalId}`);
    assertApprovalEnvelopeIdentity(envelope, {
      canonicalProposalId: proposal.proposalId,
      sourceFeatureId: 'F231',
      ownerUserId: proposal.createdBy,
      requesterCatId: proposal.sourceCatId,
      createdAt: proposal.createdAt,
    });
    await commitRedisApprovalEnvelope(this.redis, ProfileUpdateProposalKeys.detail(proposalId), envelope);
  }

  async abortStaged(proposalId: string, _reason: string): Promise<void> {
    const proposal = await this.get(proposalId);
    if (!proposal) return;
    await abortRedisStaged(
      this.redis,
      ProfileUpdateProposalKeys.detail(proposalId),
      [
        ProfileUpdateProposalKeys.userPending(proposal.createdBy),
        ProfileUpdateProposalKeys.userSettled(proposal.createdBy),
        ProfileUpdateProposalKeys.threadList(proposal.sourceThreadId),
      ],
      proposalId,
    );
  }

  async delete(proposalId: string): Promise<void> {
    const proposal = await this.get(proposalId);
    const pipeline = this.redis.multi();
    pipeline.del(ProfileUpdateProposalKeys.detail(proposalId));
    if (proposal) {
      pipeline.zrem(ProfileUpdateProposalKeys.userPending(proposal.createdBy), proposalId);
      pipeline.zrem(ProfileUpdateProposalKeys.threadList(proposal.sourceThreadId), proposalId);
    }
    await pipeline.exec();
  }

  private async cas(
    proposalId: string,
    userId: string,
    expected: ProfileUpdateProposalStatus,
    pendingAction: 'zrem' | 'zadd' | 'noop',
    score: string,
    fields: string[],
  ): Promise<boolean> {
    const result = await this.redis.eval(
      CAS_TRANSITION_LUA,
      2,
      ProfileUpdateProposalKeys.detail(proposalId),
      ProfileUpdateProposalKeys.userPending(userId),
      proposalId,
      expected,
      pendingAction,
      score,
      ...fields,
    );
    return result === 1;
  }

  private async loadFromIndex(indexKey: string, limit: number): Promise<ProfileUpdateProposal[]> {
    const ids = await this.redis.zrevrange(indexKey, 0, Math.max(0, limit - 1));
    const out: ProfileUpdateProposal[] = [];
    for (const id of ids) {
      const p = await this.get(id);
      if (p) out.push(p);
    }
    return out;
  }
}
