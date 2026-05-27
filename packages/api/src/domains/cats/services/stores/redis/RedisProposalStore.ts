/**
 * Redis-backed F128 Proposal store.
 *
 * Data structures:
 * - Hash proposal:{proposalId} — proposal fields
 * - SortedSet proposals:user:{userId} — all proposals for user (score=createdAt)
 * - SortedSet proposals:pending:{userId} — pending-only ids (zrem on approve/reject)
 * - SortedSet proposals:thread:{threadId} — proposals proposed in a thread
 * - String dedup:propose:{userId}:{clientRequestId} → proposalId (short TTL)
 *
 * IMPORTANT: ioredis keyPrefix auto-prefixes ALL commands.
 */

import type { ProposalStatus, ThreadProposal } from '@cat-cafe/shared';
import { generateProposalId } from '@cat-cafe/shared';
import type { RedisClient } from '@cat-cafe/shared/utils';
import type {
  ClaimForApprovalInput,
  CreateProposalInput,
  FinalizeApprovalInput,
  IProposalStore,
  RejectProposalInput,
} from '../ports/ProposalStore.js';
import { ProposalKeys } from '../redis-keys/proposal-keys.js';
import {
  applyFinalize,
  CAS_TRANSITION_LUA,
  hydrateProposal,
  RECORD_CREATED_THREAD_LUA,
  RELEASE_DEDUP_LUA,
  serializeProposal,
} from './RedisProposalStoreHelpers.js';

const DEFAULT_DEDUP_TTL_SECONDS = 10 * 60; // 10 minutes — idempotency key only, not user-visible state
const DEFAULT_LIST_LIMIT = 100;

export class RedisProposalStore implements IProposalStore {
  private readonly redis: RedisClient;
  private readonly ttlSeconds: number | null;
  private readonly dedupTtlSeconds: number;

  constructor(redis: RedisClient, options?: { ttlSeconds?: number; dedupTtlSeconds?: number }) {
    this.redis = redis;
    // Iron law #5 (LL-048): user-visible/recoverable state defaults to persistent (no TTL).
    // Proposal hashes carry approval-card UI state + audit lineage (createdFromProposalId);
    // an automatic expiry would 404 old cards, orphan pending/user/thread zset members, and
    // erase the approval trail. TTL is only set when the caller explicitly opts in with
    // ttlSeconds > 0.
    const ttl = options?.ttlSeconds;
    if (ttl !== undefined && Number.isFinite(ttl) && ttl > 0) {
      this.ttlSeconds = Math.floor(ttl);
    } else {
      this.ttlSeconds = null;
    }
    this.dedupTtlSeconds = options?.dedupTtlSeconds ?? DEFAULT_DEDUP_TTL_SECONDS;
  }

  async create(input: CreateProposalInput): Promise<ThreadProposal> {
    const now = Date.now();
    const proposal: ThreadProposal = {
      proposalId: input.proposalId ?? generateProposalId(),
      status: 'pending',
      sourceThreadId: input.sourceThreadId,
      sourceInvocationId: input.sourceInvocationId,
      sourceCatId: input.sourceCatId,
      title: input.title,
      reason: input.reason,
      parentThreadId: input.parentThreadId,
      preferredCats: [...input.preferredCats],
      projectPath: input.projectPath,
      createdBy: input.createdBy,
      createdAt: now,
      ...(input.initialMessage ? { initialMessage: input.initialMessage } : {}),
    };

    const key = ProposalKeys.detail(proposal.proposalId);
    const pipeline = this.redis.multi();
    pipeline.hset(key, ...this.serialize(proposal));
    if (this.ttlSeconds) pipeline.expire(key, this.ttlSeconds);
    pipeline.zadd(ProposalKeys.userList(proposal.createdBy), String(now), proposal.proposalId);
    pipeline.zadd(ProposalKeys.userPending(proposal.createdBy), String(now), proposal.proposalId);
    pipeline.zadd(ProposalKeys.threadList(proposal.sourceThreadId), String(now), proposal.proposalId);
    await pipeline.exec();
    return proposal;
  }

  async get(proposalId: string): Promise<ThreadProposal | null> {
    const data = await this.redis.hgetall(ProposalKeys.detail(proposalId));
    if (!data || !data.proposalId) return null;
    return this.hydrate(data);
  }

  async listByUser(userId: string, limit: number = DEFAULT_LIST_LIMIT): Promise<ThreadProposal[]> {
    return this.loadFromIndex(ProposalKeys.userList(userId), limit);
  }

  async listPending(userId: string, limit: number = DEFAULT_LIST_LIMIT): Promise<ThreadProposal[]> {
    return this.loadFromIndex(ProposalKeys.userPending(userId), limit);
  }

  async listByThread(threadId: string, limit: number = DEFAULT_LIST_LIMIT): Promise<ThreadProposal[]> {
    return this.loadFromIndex(ProposalKeys.threadList(threadId), limit);
  }

  async claimForApproval(input: ClaimForApprovalInput): Promise<ThreadProposal | null> {
    const proposal = await this.get(input.proposalId);
    if (!proposal || proposal.status !== 'pending') return null;
    const claimedAt = Date.now();
    const ok = await this.casTransition(proposal.proposalId, proposal.createdBy, 'pending', 'zrem', '', [
      'status',
      'approving',
      'approvedBy',
      input.approvedBy,
      'claimedAt',
      String(claimedAt),
    ]);
    if (!ok) return null;
    return { ...proposal, status: 'approving', approvedBy: input.approvedBy, claimedAt };
  }

  async finalizeApproval(input: FinalizeApprovalInput): Promise<ThreadProposal | null> {
    const proposal = await this.get(input.proposalId);
    if (!proposal || proposal.status !== 'approving') return null;
    const now = Date.now();
    const updated = applyFinalize(proposal, input, now);
    const pairs = this.finalizedFields(updated);
    const ok = await this.casTransition(updated.proposalId, updated.createdBy, 'approving', 'noop', '', pairs);
    return ok ? updated : null;
  }

  async recordCreatedThread(proposalId: string, threadId: string): Promise<void> {
    await this.redis.eval(RECORD_CREATED_THREAD_LUA, 1, ProposalKeys.detail(proposalId), threadId);
  }

  async rollbackClaim(proposalId: string): Promise<boolean> {
    const proposal = await this.get(proposalId);
    if (!proposal || proposal.status !== 'approving') return false;
    return this.casTransition(
      proposal.proposalId,
      proposal.createdBy,
      'approving',
      'zadd',
      String(proposal.createdAt),
      ['status', 'pending', 'approvedBy', '', 'claimedAt', '0'],
    );
  }

  async markRejected(input: RejectProposalInput): Promise<ThreadProposal | null> {
    const proposal = await this.get(input.proposalId);
    if (!proposal || proposal.status !== 'pending') return null;
    const now = Date.now();
    const updated: ThreadProposal = {
      ...proposal,
      status: 'rejected',
      rejectedBy: input.rejectedBy,
      rejectedAt: now,
      ...(input.rejectionReason ? { rejectionReason: input.rejectionReason } : {}),
    };
    const pairs = ['status', 'rejected', 'rejectedBy', input.rejectedBy, 'rejectedAt', String(now)];
    if (input.rejectionReason) pairs.push('rejectionReason', input.rejectionReason);
    const ok = await this.casTransition(updated.proposalId, updated.createdBy, 'pending', 'zrem', '', pairs);
    return ok ? updated : null;
  }

  async getDedupProposalId(userId: string, clientRequestId: string): Promise<string | null> {
    return this.redis.get(ProposalKeys.dedup(userId, clientRequestId));
  }

  /** Atomic SET NX: returns the value actually stored (newly set or existing). */
  async reserveDedup(userId: string, clientRequestId: string, proposalId: string): Promise<string> {
    const key = ProposalKeys.dedup(userId, clientRequestId);
    const result = await this.redis.set(key, proposalId, 'EX', this.dedupTtlSeconds, 'NX');
    if (result === 'OK') return proposalId;
    const existing = await this.redis.get(key);
    return existing ?? proposalId;
  }

  /**
   * Mark the proposal as visible: persist the rich-card messageId. Until this is set,
   * dedup fast paths return 503 retryable so callers don't act on a phantom proposalId.
   */
  async setCardMessageId(proposalId: string, cardMessageId: string): Promise<void> {
    await this.redis.hset(ProposalKeys.detail(proposalId), 'cardMessageId', cardMessageId);
  }

  /**
   * Hard delete: remove proposal hash + all index entries. Idempotent.
   * Used to clean up after propose's card append fails so retries can re-create a visible card.
   */
  async delete(proposalId: string): Promise<void> {
    const proposal = await this.get(proposalId);
    const pipeline = this.redis.multi();
    pipeline.del(ProposalKeys.detail(proposalId));
    if (proposal) {
      pipeline.zrem(ProposalKeys.userList(proposal.createdBy), proposalId);
      pipeline.zrem(ProposalKeys.userPending(proposal.createdBy), proposalId);
      pipeline.zrem(ProposalKeys.threadList(proposal.sourceThreadId), proposalId);
    }
    await pipeline.exec();
  }

  /**
   * Release a previously reserved dedup key IF it still points at expectedProposalId.
   * Uses a small Lua script for atomic compare-and-delete so we never wipe a sibling's
   * reservation if a different winner has already replaced the key.
   */
  async releaseDedup(userId: string, clientRequestId: string, expectedProposalId: string): Promise<void> {
    await this.redis.eval(RELEASE_DEDUP_LUA, 1, ProposalKeys.dedup(userId, clientRequestId), expectedProposalId);
  }

  private async casTransition(
    proposalId: string,
    userId: string,
    expectedStatus: ProposalStatus,
    pendingIndexAction: 'zrem' | 'zadd' | 'noop',
    zaddScore: string,
    fieldPairs: string[],
  ): Promise<boolean> {
    const result = (await this.redis.eval(
      CAS_TRANSITION_LUA,
      2,
      ProposalKeys.detail(proposalId),
      ProposalKeys.userPending(userId),
      proposalId,
      expectedStatus,
      pendingIndexAction,
      zaddScore,
      ...fieldPairs,
    )) as number;
    return result === 1;
  }

  private finalizedFields(updated: ThreadProposal): string[] {
    const fields: string[] = [
      'status',
      'approved',
      'approvedAt',
      String(updated.approvedAt ?? 0),
      'claimedAt',
      '0',
      'title',
      updated.title,
      'parentThreadId',
      updated.parentThreadId,
      'preferredCats',
      JSON.stringify(updated.preferredCats),
    ];
    if (updated.createdThreadId) fields.push('createdThreadId', updated.createdThreadId);
    if (updated.initialMessage !== undefined) {
      fields.push('initialMessage', updated.initialMessage);
    } else {
      fields.push('initialMessage', '');
    }
    return fields;
  }

  private async loadFromIndex(indexKey: string, limit: number): Promise<ThreadProposal[]> {
    const ids = await this.redis.zrevrange(indexKey, 0, Math.max(0, limit - 1));
    if (ids.length === 0) return [];
    const pipeline = this.redis.pipeline();
    for (const id of ids) pipeline.hgetall(ProposalKeys.detail(id));
    const results = await pipeline.exec();
    if (!results) return [];
    const records: ThreadProposal[] = [];
    for (const [err, data] of results) {
      if (err || !data || typeof data !== 'object') continue;
      const d = data as Record<string, string>;
      if (!d.proposalId) continue;
      records.push(hydrateProposal(d));
    }
    return records;
  }

  private serialize(proposal: ThreadProposal): string[] {
    return serializeProposal(proposal);
  }

  private hydrate(data: Record<string, string>): ThreadProposal {
    return hydrateProposal(data);
  }
}
