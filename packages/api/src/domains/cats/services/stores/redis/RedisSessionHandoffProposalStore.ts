/**
 * F225 Redis-backed SessionHandoffProposalStore.
 *
 * 对齐 F128 RedisProposalStore 的 CAS Lua 模式（KD-5：复用 claimForApproval 的 CAS 思路，
 * 不复用 ThreadProposal shape），承载 commit-point checkpoint 字段（KD-8/9）。
 *
 * Data structures（key prefix `cat-cafe:` 由 RedisClient 注入）:
 * - Hash  handoff-proposal:{proposalId}                    — proposal 字段（note 整体 JSON）
 * - ZSet  handoff-proposals:session:{sourceSessionId}      — A4 ≤1 pending/active session（score=createdAt）
 * - ZSet  handoff-proposals:catthread:{catId}:{threadId}   — A4 cooldown getMostRecentByCatThread（score=createdAt）
 *
 * Iron law #5 (LL-048): proposal 是 user-visible 确认卡状态（cardMessageId / 审批谱系）→
 * 默认无 TTL（持久化）。自动过期会 404 旧卡 + 残留 session/catthread zset 成员 + 抹掉审批轨迹。
 */

import type {
  ApprovalEnvelope,
  ApprovalPublication,
  CatId,
  HumanDispositionLedgerEntry,
  SessionHandoffProposal,
} from '@cat-cafe/shared';
import {
  assertApprovalEnvelopeIdentity,
  buildHumanDispositionLedgerReceipt,
  generateProposalId,
  humanDispositionLedgerEntrySchema,
} from '@cat-cafe/shared';
import type { RedisClient } from '@cat-cafe/shared/utils';
import type {
  RejectSessionHandoffInput,
  SessionHandoffDispositionEntryLookup,
  SessionHandoffRejectionResult,
} from '../ports/SessionHandoffDisposition.js';
import { sessionHandoffProposalIdFromSourceRef } from '../ports/SessionHandoffDisposition.js';
import type {
  CreateHandoffProposalInput,
  HandoffCheckpointPatch,
  ISessionHandoffProposalStore,
} from '../ports/SessionHandoffProposalStore.js';
import { abortRedisStaged, commitRedisApprovalEnvelope } from './RedisApprovalPublication.js';
import { rejectSessionHandoffWithDisposition } from './RedisSessionHandoffDisposition.js';
import { hydrateSessionHandoffProposal, serializeSessionHandoffProposal } from './RedisSessionHandoffProposalCodec.js';
import { CAS_AND_SETTLE_LUA, CAS_STATUS_LUA, RELEASE_DEDUP_LUA } from './redis-handoff-lua-scripts.js';
import { HandoffKeys } from './session-handoff-keys.js';

const ACTIVE_STATUSES: ReadonlySet<string> = new Set(['pending', 'approving']);

/** TTL for the transport-retry dedup index. This is a transient idempotency guard (NOT the
 * user-visible proposal state which stays TTL=0 per LL-048) — bounded well beyond any
 * callbackPost retry window so the key self-cleans without leaking. */
const DEDUP_TTL_SECONDS = 3600;

export class RedisSessionHandoffProposalStore implements ISessionHandoffProposalStore {
  private readonly redis: RedisClient;
  // Monotonic clock: same-ms creates still get strictly increasing createdAt/score, so
  // getMostRecentByCatThread (zrevrange) is deterministic, not a Redis tie-break (砚砚 P1-3).
  private lastTs = 0;

  constructor(redis: RedisClient) {
    this.redis = redis;
  }

  private monoNow(): number {
    const n = Date.now();
    this.lastTs = n > this.lastTs ? n : this.lastTs + 1;
    return this.lastTs;
  }

  async create(input: CreateHandoffProposalInput): Promise<SessionHandoffProposal> {
    const now = this.monoNow();
    const proposalId = input.proposalId ?? generateProposalId();
    const proposal: SessionHandoffProposal = {
      kind: 'session_handoff',
      proposalId,
      status: 'pending',
      sourceThreadId: input.sourceThreadId,
      sourceSessionId: input.sourceSessionId,
      sourceCatId: input.sourceCatId,
      sourceMessageId: input.sourceMessageId,
      userId: input.userId,
      note: {
        ...input.note,
        proposalId,
        sourceSessionId: input.sourceSessionId,
        persistedAt: now,
      },
      createdAt: now,
      updatedAt: now,
      publication: { state: 'staged', stagedAt: now },
    };
    const pipeline = this.redis.multi();
    pipeline.hset(HandoffKeys.detail(proposalId), ...serializeSessionHandoffProposal(proposal));
    pipeline.zadd(HandoffKeys.session(proposal.sourceSessionId), String(now), proposalId);
    pipeline.zadd(
      HandoffKeys.catThread(proposal.userId, proposal.sourceCatId, proposal.sourceThreadId),
      String(now),
      proposalId,
    );
    pipeline.zadd(HandoffKeys.user(proposal.userId), String(now), proposalId);
    await pipeline.exec();
    return proposal;
  }

  async get(proposalId: string): Promise<SessionHandoffProposal | null> {
    const data = await this.redis.hgetall(HandoffKeys.detail(proposalId));
    if (!data || !data.proposalId) return null;
    return hydrateSessionHandoffProposal(data);
  }

  async claimForApproval(proposalId: string): Promise<SessionHandoffProposal | null> {
    const ok = await this.cas(proposalId, 'pending', ['status', 'approving', 'updatedAt', String(Date.now())]);
    return ok ? this.get(proposalId) : null;
  }

  async recordCheckpoint(proposalId: string, patch: HandoffCheckpointPatch): Promise<SessionHandoffProposal | null> {
    // checkpoint 单调推进，幂等，不改 status（不 CAS）。先确认存在再 HSET。
    const existing = await this.get(proposalId);
    if (!existing) return null;
    const pairs: string[] = ['updatedAt', String(Date.now())];
    if (patch.handoffNotePersistedAt !== undefined)
      pairs.push('handoffNotePersistedAt', String(patch.handoffNotePersistedAt));
    if (patch.sealedSessionId !== undefined) pairs.push('sealedSessionId', patch.sealedSessionId);
    if (patch.sealAcceptedAt !== undefined) pairs.push('sealAcceptedAt', String(patch.sealAcceptedAt));
    if (patch.continuationEntryId !== undefined) pairs.push('continuationEntryId', patch.continuationEntryId);
    if (patch.cardMessageId !== undefined) pairs.push('cardMessageId', patch.cardMessageId);
    await this.redis.hset(HandoffKeys.detail(proposalId), ...pairs);
    return this.get(proposalId);
  }

  async finalizeApproval(proposalId: string): Promise<SessionHandoffProposal | null> {
    // Pre-read to obtain userId (needed for index key computation in casAndSettle).
    // The CAS check inside casAndSettle is still atomic — pre-read is only for userId.
    const existing = await this.get(proposalId);
    if (!existing || existing.status !== 'approving') return null;
    const ok = await this.casAndSettle(proposalId, existing.userId, 'approving', 'approved', Date.now());
    if (!ok) return null;
    return this.get(proposalId);
  }

  async markRejected(proposalId: string, input: RejectSessionHandoffInput): Promise<SessionHandoffRejectionResult> {
    return rejectSessionHandoffWithDisposition(this.redis, proposalId, input, (id) => this.get(id));
  }

  async loadHumanDispositionEntry(
    input: SessionHandoffDispositionEntryLookup,
  ): Promise<HumanDispositionLedgerEntry | null> {
    const proposalId = sessionHandoffProposalIdFromSourceRef(input.receipt.sourceRef);
    if (!proposalId) return null;
    const proposal = await this.get(proposalId);
    if (!proposal || proposal.userId !== input.ownerUserId) return null;
    const entry = humanDispositionLedgerEntrySchema.safeParse(proposal.humanDispositionLedgerEntry);
    if (!entry.success) return null;
    const receipt = buildHumanDispositionLedgerReceipt(entry.data);
    return JSON.stringify(receipt) === JSON.stringify(input.receipt) ? entry.data : null;
  }

  async markExpired(proposalId: string): Promise<SessionHandoffProposal | null> {
    const ok = await this.cas(proposalId, 'pending,approving', ['status', 'expired', 'updatedAt', String(Date.now())]);
    if (!ok) return null;
    const result = await this.get(proposalId);
    if (result) await this.redis.zrem(HandoffKeys.user(result.userId), proposalId);
    return result;
  }

  async listActiveBySession(sourceSessionId: string): Promise<SessionHandoffProposal[]> {
    const ids = await this.redis.zrange(HandoffKeys.session(sourceSessionId), 0, -1);
    if (ids.length === 0) return [];
    const pipeline = this.redis.pipeline();
    for (const id of ids) pipeline.hgetall(HandoffKeys.detail(id));
    const results = await pipeline.exec();
    if (!results) return [];
    const out: SessionHandoffProposal[] = [];
    for (const [err, data] of results) {
      if (err || !data || typeof data !== 'object') continue;
      const d = data as Record<string, string>;
      if (!d.proposalId || !ACTIVE_STATUSES.has(d.status)) continue;
      out.push(hydrateSessionHandoffProposal(d));
    }
    return out;
  }

  async listPendingByUser(userId: string, limit = 100): Promise<SessionHandoffProposal[]> {
    // Read from user ZSet (score=createdAt), reverse order (newest first), filter pending in JS.
    // Consistent with listActiveBySession pattern: index tracks all statuses, filter at read time.
    const ids = await this.redis.zrevrange(HandoffKeys.user(userId), 0, -1);
    if (ids.length === 0) return [];
    const pipeline = this.redis.pipeline();
    for (const id of ids) pipeline.hgetall(HandoffKeys.detail(id));
    const results = await pipeline.exec();
    if (!results) return [];
    const out: SessionHandoffProposal[] = [];
    for (const [err, data] of results) {
      if (err || !data || typeof data !== 'object') continue;
      const d = data as Record<string, string>;
      if (!d.proposalId || d.status !== 'pending') continue;
      out.push(hydrateSessionHandoffProposal(d));
      if (out.length >= limit) break;
    }
    return out;
  }

  async listSettledByUser(userId: string, limit = 100): Promise<SessionHandoffProposal[]> {
    // Read from settled ZSet (score=updatedAt), newest first (ZREVRANGE).
    const ids = await this.redis.zrevrange(HandoffKeys.settledUser(userId), 0, limit - 1);
    if (ids.length === 0) return [];
    const pipeline = this.redis.pipeline();
    for (const id of ids) pipeline.hgetall(HandoffKeys.detail(id));
    const results = await pipeline.exec();
    if (!results) return [];
    const out: SessionHandoffProposal[] = [];
    for (const [err, data] of results) {
      if (err || !data || typeof data !== 'object') continue;
      const d = data as Record<string, string>;
      if (!d.proposalId) continue;
      // Double-check status in case of stale index membership
      if (d.status !== 'approved' && d.status !== 'rejected') continue;
      out.push(hydrateSessionHandoffProposal(d));
    }
    return out;
  }

  async getMostRecentByCatThread(
    userId: string,
    sourceCatId: CatId,
    sourceThreadId: string,
  ): Promise<SessionHandoffProposal | null> {
    const ids = await this.redis.zrevrange(HandoffKeys.catThread(userId, sourceCatId, sourceThreadId), 0, 0);
    const id = ids[0];
    return id ? this.get(id) : null;
  }

  async countRecentByCatThread(
    userId: string,
    sourceCatId: CatId,
    sourceThreadId: string,
    sinceTs: number,
  ): Promise<number> {
    // ZCOUNT the catthread index by score (= createdAt) in [sinceTs, +inf): proposals in the window.
    return this.redis.zcount(HandoffKeys.catThread(userId, sourceCatId, sourceThreadId), sinceTs, '+inf');
  }

  async delete(proposalId: string): Promise<void> {
    // Read first so we can also ZREM the index members, not just DEL the hash. Idempotent.
    const existing = await this.get(proposalId);
    const pipeline = this.redis.multi();
    pipeline.del(HandoffKeys.detail(proposalId));
    if (existing) {
      pipeline.zrem(HandoffKeys.session(existing.sourceSessionId), proposalId);
      pipeline.zrem(HandoffKeys.catThread(existing.userId, existing.sourceCatId, existing.sourceThreadId), proposalId);
      pipeline.zrem(HandoffKeys.user(existing.userId), proposalId);
    }
    await pipeline.exec();
  }

  async getDedupProposalId(userId: string, clientRequestId: string): Promise<string | null> {
    return this.redis.get(HandoffKeys.dedup(userId, clientRequestId));
  }

  /** Atomic SET NX: returns the value actually stored (newly set or the prior winner's). */
  async reserveDedup(userId: string, clientRequestId: string, proposalId: string): Promise<string> {
    const key = HandoffKeys.dedup(userId, clientRequestId);
    const result = await this.redis.set(key, proposalId, 'EX', DEDUP_TTL_SECONDS, 'NX');
    if (result === 'OK') return proposalId;
    const existing = await this.redis.get(key);
    return existing ?? proposalId;
  }

  async releaseDedup(userId: string, clientRequestId: string, expectedProposalId: string): Promise<void> {
    await this.redis.eval(RELEASE_DEDUP_LUA, 1, HandoffKeys.dedup(userId, clientRequestId), expectedProposalId);
  }

  async getPublication(proposalId: string): Promise<ApprovalPublication | null> {
    return (await this.get(proposalId))?.publication ?? null;
  }

  async commitEnvelope(proposalId: string, envelope: ApprovalEnvelope): Promise<void> {
    const proposal = await this.get(proposalId);
    if (!proposal) throw new Error(`proposal not found: ${proposalId}`);
    assertApprovalEnvelopeIdentity(envelope, {
      canonicalProposalId: proposal.proposalId,
      sourceFeatureId: 'F225',
      ownerUserId: proposal.userId,
      requesterCatId: proposal.sourceCatId,
      createdAt: proposal.createdAt,
    });
    await commitRedisApprovalEnvelope(this.redis, HandoffKeys.detail(proposalId), envelope);
  }

  async abortStaged(proposalId: string, _reason: string): Promise<void> {
    const proposal = await this.get(proposalId);
    if (!proposal) return;
    await abortRedisStaged(
      this.redis,
      HandoffKeys.detail(proposalId),
      [
        HandoffKeys.session(proposal.sourceSessionId),
        HandoffKeys.catThread(proposal.userId, proposal.sourceCatId, proposal.sourceThreadId),
        HandoffKeys.user(proposal.userId),
        HandoffKeys.settledUser(proposal.userId),
      ],
      proposalId,
    );
  }

  private async cas(proposalId: string, expected: string, pairs: string[]): Promise<boolean> {
    const result = (await this.redis.eval(
      CAS_STATUS_LUA,
      1,
      HandoffKeys.detail(proposalId),
      expected,
      ...pairs,
    )) as number;
    return result === 1;
  }

  /**
   * Atomic CAS + settled-index update via CAS_AND_SETTLE_LUA.
   * Eliminates the crash window between status transition and ZADD.
   */
  private async casAndSettle(
    proposalId: string,
    userId: string,
    expectedStatus: string,
    newStatus: string,
    updatedAt: number,
  ): Promise<boolean> {
    const result = (await this.redis.eval(
      CAS_AND_SETTLE_LUA,
      3,
      HandoffKeys.detail(proposalId), // KEYS[1]
      HandoffKeys.user(userId), // KEYS[2]
      HandoffKeys.settledUser(userId), // KEYS[3]
      expectedStatus, // ARGV[1]
      newStatus, // ARGV[2]
      String(updatedAt), // ARGV[3]
      proposalId, // ARGV[4]
      '', // ARGV[5] — approve has no rejection feedback
    )) as string;
    return result === 'APPLIED';
  }
}
