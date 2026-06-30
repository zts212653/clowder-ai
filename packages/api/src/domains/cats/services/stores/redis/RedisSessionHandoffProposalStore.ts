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

import type { CatId, HandoffProposalStatus, SessionHandoffProposal } from '@cat-cafe/shared';
import { generateProposalId } from '@cat-cafe/shared';
import type { RedisClient } from '@cat-cafe/shared/utils';
import type {
  CreateHandoffProposalInput,
  HandoffCheckpointPatch,
  ISessionHandoffProposalStore,
} from '../ports/SessionHandoffProposalStore.js';
import { CAS_AND_SETTLE_LUA, CAS_STATUS_LUA, RELEASE_DEDUP_LUA } from './redis-handoff-lua-scripts.js';

const ACTIVE_STATUSES: ReadonlySet<string> = new Set(['pending', 'approving']);

const HandoffKeys = {
  detail: (id: string) => `handoff-proposal:${id}`,
  session: (sessionId: string) => `handoff-proposals:session:${sessionId}`,
  catThread: (userId: string, catId: string, threadId: string) =>
    `handoff-proposals:catthread:${userId}:${catId}:${threadId}`,
  /** F246 Approval Hub: per-user index for listPendingByUser (score=createdAt). */
  user: (userId: string) => `handoff-proposals:user:${userId}`,
  /** F246 Phase G: per-user settled (approved|rejected) index for listSettledByUser (score=updatedAt). */
  settledUser: (userId: string) => `handoff-proposals:settled:${userId}`,
  dedup: (userId: string, clientRequestId: string) => `handoff-proposal-dedup:${userId}:${clientRequestId}`,
};

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
      userId: input.userId,
      note: {
        ...input.note,
        proposalId,
        sourceSessionId: input.sourceSessionId,
        persistedAt: now,
      },
      createdAt: now,
      updatedAt: now,
    };
    const pipeline = this.redis.multi();
    pipeline.hset(HandoffKeys.detail(proposalId), ...serialize(proposal));
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
    return hydrate(data);
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

  async markRejected(proposalId: string): Promise<SessionHandoffProposal | null> {
    // Pre-read to obtain userId (needed for index key computation in casAndSettle).
    const existing = await this.get(proposalId);
    if (!existing || existing.status !== 'pending') return null;
    const ok = await this.casAndSettle(proposalId, existing.userId, 'pending', 'rejected', Date.now());
    if (!ok) return null;
    return this.get(proposalId);
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
      out.push(hydrate(d));
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
      out.push(hydrate(d));
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
      out.push(hydrate(d));
    }
    return out;
  }

  async getMostRecentByCatThread(
    userId: string,
    sourceCatId: CatId,
    sourceThreadId: string,
  ): Promise<SessionHandoffProposal | null> {
    const ids = await this.redis.zrevrange(HandoffKeys.catThread(userId, sourceCatId, sourceThreadId), 0, 0);
    if (ids.length === 0) return null;
    return this.get(ids[0]!);
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
    )) as number;
    return result === 1;
  }
}

/** proposal → flat hash field/value pairs（note 整体 JSON，checkpoint 字段可选）。 */
function serialize(p: SessionHandoffProposal): string[] {
  const fields: string[] = [
    'kind',
    p.kind,
    'proposalId',
    p.proposalId,
    'status',
    p.status,
    'sourceThreadId',
    p.sourceThreadId,
    'sourceSessionId',
    p.sourceSessionId,
    'sourceCatId',
    p.sourceCatId,
    'userId',
    p.userId,
    'note',
    JSON.stringify(p.note),
    'createdAt',
    String(p.createdAt),
    'updatedAt',
    String(p.updatedAt),
  ];
  if (p.handoffNotePersistedAt !== undefined) fields.push('handoffNotePersistedAt', String(p.handoffNotePersistedAt));
  if (p.sealedSessionId !== undefined) fields.push('sealedSessionId', p.sealedSessionId);
  if (p.sealAcceptedAt !== undefined) fields.push('sealAcceptedAt', String(p.sealAcceptedAt));
  if (p.continuationEntryId !== undefined) fields.push('continuationEntryId', p.continuationEntryId);
  if (p.cardMessageId !== undefined) fields.push('cardMessageId', p.cardMessageId);
  return fields;
}

/** flat hash → proposal（note JSON.parse，数字 parseInt，checkpoint 字段条件加）。 */
function hydrate(data: Record<string, string>): SessionHandoffProposal {
  const proposal: SessionHandoffProposal = {
    kind: 'session_handoff',
    proposalId: data.proposalId!,
    status: data.status as HandoffProposalStatus,
    sourceThreadId: data.sourceThreadId!,
    sourceSessionId: data.sourceSessionId!,
    sourceCatId: data.sourceCatId! as CatId,
    userId: data.userId!,
    note: JSON.parse(data.note!),
    createdAt: parseInt(data.createdAt!, 10),
    updatedAt: parseInt(data.updatedAt!, 10),
  };
  if (data.handoffNotePersistedAt) proposal.handoffNotePersistedAt = parseInt(data.handoffNotePersistedAt, 10);
  if (data.sealedSessionId) proposal.sealedSessionId = data.sealedSessionId;
  if (data.sealAcceptedAt) proposal.sealAcceptedAt = parseInt(data.sealAcceptedAt, 10);
  if (data.continuationEntryId) proposal.continuationEntryId = data.continuationEntryId;
  if (data.cardMessageId) proposal.cardMessageId = data.cardMessageId;
  return proposal;
}
