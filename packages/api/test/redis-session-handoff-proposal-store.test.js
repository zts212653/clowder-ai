/**
 * RedisSessionHandoffProposalStore tests (F225 Task A1 — Redis-backed).
 * 有 Redis → 测全量；无 Redis → skip。
 *
 * 重点（砚砚 feedback_inmemory）：Redis serialize/hydrate 往返不丢字段——
 * 嵌套 note 对象 + commits 数组 + commit-point checkpoint 字段全维度断言；
 * CAS claim 用真并发（Promise.all）证明 Lua 原子性，不靠 JS 单线程蒙混。
 */

import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, it } from 'node:test';
import {
  assertRedisIsolationOrThrow,
  cleanupPrefixedRedisKeys,
  redisIsolationSkipReason,
} from './helpers/redis-test-helpers.js';

const REDIS_URL = process.env.REDIS_URL;

const HANDOFF_PATTERNS = [
  'handoff-proposal:*',
  'handoff-proposals:session:*',
  'handoff-proposals:catthread:*',
  'handoff-proposal-dedup:*',
];

describe('RedisSessionHandoffProposalStore', { skip: redisIsolationSkipReason(REDIS_URL) }, () => {
  let RedisSessionHandoffProposalStore;
  let createRedisClient;
  let redis;
  let store;
  let connected = false;

  before(async () => {
    assertRedisIsolationOrThrow(REDIS_URL, 'RedisSessionHandoffProposalStore');

    const storeModule = await import('../dist/domains/cats/services/stores/redis/RedisSessionHandoffProposalStore.js');
    RedisSessionHandoffProposalStore = storeModule.RedisSessionHandoffProposalStore;
    const redisModule = await import('@cat-cafe/shared/utils');
    createRedisClient = redisModule.createRedisClient;

    redis = createRedisClient({ url: REDIS_URL });
    try {
      await redis.ping();
      connected = true;
    } catch {
      console.warn('[redis-session-handoff-proposal-store.test] Redis unreachable, skipping');
      await redis.quit().catch(() => {});
      return;
    }
    store = new RedisSessionHandoffProposalStore(redis);
  });

  after(async () => {
    if (redis && connected) {
      await cleanupPrefixedRedisKeys(redis, HANDOFF_PATTERNS);
      await redis.quit();
    }
  });

  beforeEach(async (t) => {
    if (!connected) return t.skip('Redis not connected');
    await cleanupPrefixedRedisKeys(redis, HANDOFF_PATTERNS);
  });

  const baseInput = (over = {}) => ({
    sourceThreadId: 'thread_1',
    sourceSessionId: 'sess_1',
    sourceCatId: 'opus-45',
    userId: 'user_1',
    note: { done: 'wrote types', nextSteps: 'write store' },
    ...over,
  });

  it('create fills note proposalId/sourceSessionId/persistedAt + status pending, round-trips via Redis', async () => {
    const p = await store.create(baseInput());
    assert.equal(p.kind, 'session_handoff');
    assert.equal(p.status, 'pending');
    assert.ok(p.proposalId);
    assert.equal(p.note.proposalId, p.proposalId);
    assert.equal(p.note.sourceSessionId, 'sess_1');
    assert.ok(p.note.persistedAt > 0);

    // Redis 往返：get 回读与 create 返回一致（serialize/hydrate 不丢字段）
    const got = await store.get(p.proposalId);
    assert.deepEqual(got, p, 'get round-trips the full proposal incl. nested note');
  });

  it('serialize/hydrate preserves ALL five-piece note fields + commits array (砚砚 feedback_inmemory)', async () => {
    const p = await store.create(
      baseInput({
        note: {
          done: 'A1 store done',
          worktreeBranch: 'feat/f225-session-handoff',
          commits: ['18d69a8', '160021a', '013c633'],
          nextSteps: 'wire route',
          gotchas: 'commit-point irreversible; keep TTL=0',
        },
      }),
    );
    const got = await store.get(p.proposalId);
    assert.equal(got.note.done, 'A1 store done');
    assert.equal(got.note.worktreeBranch, 'feat/f225-session-handoff');
    assert.deepEqual(got.note.commits, ['18d69a8', '160021a', '013c633'], 'commits array survives JSON round-trip');
    assert.equal(got.note.nextSteps, 'wire route');
    assert.equal(got.note.gotchas, 'commit-point irreversible; keep TTL=0');
  });

  it('claimForApproval: concurrent CAS — exactly one wins (Lua atomicity, not JS single-thread)', async () => {
    const p = await store.create(baseInput());
    const [a, b] = await Promise.all([store.claimForApproval(p.proposalId), store.claimForApproval(p.proposalId)]);
    const winners = [a, b].filter(Boolean);
    assert.equal(winners.length, 1, 'exactly one concurrent claim wins');
    assert.equal(winners[0].status, 'approving');
    assert.equal((await store.get(p.proposalId)).status, 'approving');
  });

  it('recordCheckpoint persists commit-point fields WITHOUT changing status + round-trips', async () => {
    const p = await store.create(baseInput());
    await store.claimForApproval(p.proposalId);
    const patched = await store.recordCheckpoint(p.proposalId, {
      handoffNotePersistedAt: 111,
      sealedSessionId: 'sess_1',
      sealAcceptedAt: 222,
      continuationEntryId: 'entry_9',
      cardMessageId: 'card_7',
    });
    assert.equal(patched.status, 'approving', 'checkpoint does not change status');
    assert.equal(patched.handoffNotePersistedAt, 111);
    assert.equal(patched.sealedSessionId, 'sess_1');
    assert.equal(patched.sealAcceptedAt, 222);
    assert.equal(patched.continuationEntryId, 'entry_9');
    assert.equal(patched.cardMessageId, 'card_7');
    // durable re-read
    const got = await store.get(p.proposalId);
    assert.equal(got.sealedSessionId, 'sess_1');
    assert.equal(got.continuationEntryId, 'entry_9');
    assert.equal(got.cardMessageId, 'card_7');
  });

  it('recordCheckpoint is idempotent + partial (only patches provided fields)', async () => {
    const p = await store.create(baseInput());
    await store.claimForApproval(p.proposalId);
    await store.recordCheckpoint(p.proposalId, { handoffNotePersistedAt: 100 });
    const got1 = await store.get(p.proposalId);
    assert.equal(got1.handoffNotePersistedAt, 100);
    assert.equal(got1.sealedSessionId, undefined, 'unpatched field stays unset');
    // later partial patch must not clobber earlier checkpoint
    await store.recordCheckpoint(p.proposalId, { sealedSessionId: 'sess_1' });
    const got2 = await store.get(p.proposalId);
    assert.equal(got2.handoffNotePersistedAt, 100, 'earlier checkpoint preserved');
    assert.equal(got2.sealedSessionId, 'sess_1');
  });

  it('recordCheckpoint on missing proposal returns null', async () => {
    assert.equal(await store.recordCheckpoint('nope', { handoffNotePersistedAt: 1 }), null);
  });

  it('finalizeApproval: CAS approving→approved (null if not approving)', async () => {
    const p = await store.create(baseInput());
    assert.equal(await store.finalizeApproval(p.proposalId), null, 'cannot finalize pending');
    await store.claimForApproval(p.proposalId);
    assert.equal((await store.finalizeApproval(p.proposalId)).status, 'approved');
  });

  it('markRejected: CAS pending→rejected (null if already claimed)', async () => {
    const p = await store.create(baseInput());
    assert.equal((await store.markRejected(p.proposalId)).status, 'rejected');
    const p2 = await store.create(baseInput());
    await store.claimForApproval(p2.proposalId);
    assert.equal(await store.markRejected(p2.proposalId), null, 'cannot reject approving');
  });

  it('markExpired: pending|approving→expired, terminal stays', async () => {
    const p = await store.create(baseInput());
    assert.equal((await store.markExpired(p.proposalId)).status, 'expired');
    const p2 = await store.create(baseInput());
    await store.claimForApproval(p2.proposalId);
    assert.equal((await store.markExpired(p2.proposalId)).status, 'expired', 'approving can expire');
    const p3 = await store.create(baseInput());
    await store.markRejected(p3.proposalId);
    assert.equal(await store.markExpired(p3.proposalId), null, 'cannot expire rejected (terminal)');
  });

  it('listActiveBySession: only pending|approving for that session (A4 ≤1 guard)', async () => {
    const p1 = await store.create(baseInput());
    await store.create(baseInput({ sourceSessionId: 'sess_2' }));
    assert.equal((await store.listActiveBySession('sess_1')).length, 1);
    await store.claimForApproval(p1.proposalId);
    assert.equal((await store.listActiveBySession('sess_1')).length, 1, 'approving still active');
    await store.markExpired(p1.proposalId);
    assert.equal((await store.listActiveBySession('sess_1')).length, 0, 'expired no longer active');
    assert.equal((await store.listActiveBySession('sess_2')).length, 1);
  });

  it('getMostRecentByCatThread: latest per-(user,cat,thread), monotonic same-ms deterministic (砚砚 P1-3/P2)', async () => {
    const p1 = await store.create(baseInput());
    await store.markRejected(p1.proposalId);
    const p2 = await store.create(baseInput());
    // P1-3: monotonic createdAt → deterministic newest even when created in the same wall-clock ms
    assert.ok(p2.createdAt > p1.createdAt, 'monotonic: p2.createdAt strictly greater (no same-ms Redis tie)');
    const recent = await store.getMostRecentByCatThread('user_1', 'opus-45', 'thread_1');
    assert.equal(recent.proposalId, p2.proposalId, 'deterministic newest, not tie-broken to the older one');
    // different cat+thread isolated
    assert.equal(await store.getMostRecentByCatThread('user_1', 'opus-45', 'other_thread'), null);
    // P2: per-user — a user_2 proposal in the same cat+thread must NOT leak into user_1's cooldown
    await store.create(baseInput({ userId: 'user_2' }));
    assert.equal(
      (await store.getMostRecentByCatThread('user_1', 'opus-45', 'thread_1')).proposalId,
      p2.proposalId,
      'user_1 cooldown unaffected by user_2 proposal',
    );
    assert.ok(await store.getMostRecentByCatThread('user_2', 'opus-45', 'thread_1'), 'user_2 has its own cooldown');
  });

  it('countRecentByCatThread: ZCOUNT window per (user,cat,thread) — A4 hourly cap (砚砚 re-review P2)', async () => {
    const p1 = await store.create(baseInput());
    const p2 = await store.create(baseInput());
    assert.equal(await store.countRecentByCatThread('user_1', 'opus-45', 'thread_1', 0), 2, 'both in window');
    // sinceTs = p2.createdAt excludes the strictly-older p1 (monotonic → p1 < p2)
    assert.equal(p2.createdAt > p1.createdAt, true);
    assert.equal(
      await store.countRecentByCatThread('user_1', 'opus-45', 'thread_1', p2.createdAt),
      1,
      'window excludes older proposal',
    );
    // per-user isolation: user_2 proposals not counted toward user_1's hourly cap
    await store.create(baseInput({ userId: 'user_2' }));
    assert.equal(await store.countRecentByCatThread('user_1', 'opus-45', 'thread_1', 0), 2, 'user_2 not counted');
    assert.equal(await store.countRecentByCatThread('user_2', 'opus-45', 'thread_1', 0), 1);
  });

  it('delete: removes hash + session/catthread index members (idempotent, card-fail cleanup)', async () => {
    const p = await store.create(baseInput());
    assert.ok(await store.get(p.proposalId));
    await store.delete(p.proposalId);
    assert.equal(await store.get(p.proposalId), null, 'hash deleted');
    assert.equal((await store.listActiveBySession('sess_1')).length, 0, 'session index member removed');
    // Pin BOTH catthread-index consumers (cooldown getMostRecent + hourly countRecent) — a stale
    // 2-arg getMostRecentByCatThread call queried the wrong key and false-passed (砚砚 final P2).
    assert.equal(
      await store.getMostRecentByCatThread('user_1', 'opus-45', 'thread_1'),
      null,
      'catthread index member removed (no cooldown residue)',
    );
    assert.equal(
      await store.countRecentByCatThread('user_1', 'opus-45', 'thread_1', 0),
      0,
      'catthread index member removed (no hourly-cap residue)',
    );
    await store.delete(p.proposalId); // idempotent — no throw on missing
  });

  it('dedup: reserveDedup atomic (concurrent → one winner), get resolves, compare-and-delete release (云端 P2)', async () => {
    // Concurrent reserve with the SAME key → exactly one winner (Lua/SET NX atomicity, not JS shimmer).
    const [a, b] = await Promise.all([
      store.reserveDedup('user_1', 'rk1', 'prop_A'),
      store.reserveDedup('user_1', 'rk1', 'prop_B'),
    ]);
    assert.equal(a, b, 'both concurrent reserves resolve to the same winning proposalId');
    const winner = a;
    assert.ok(winner === 'prop_A' || winner === 'prop_B');
    assert.equal(await store.getDedupProposalId('user_1', 'rk1'), winner, 'get returns the reserved winner');
    // per-user scoping: another user's same clientRequestId is isolated
    assert.equal(await store.getDedupProposalId('user_2', 'rk1'), null, 'dedup key scoped per user');
    // compare-and-delete: release with a non-winning id is a no-op (never wipes a sibling reservation)
    await store.releaseDedup('user_1', 'rk1', 'not-the-winner');
    assert.equal(await store.getDedupProposalId('user_1', 'rk1'), winner, 'release with wrong id is a no-op');
    await store.releaseDedup('user_1', 'rk1', winner);
    assert.equal(await store.getDedupProposalId('user_1', 'rk1'), null, 'release frees the key for a clean retry');
  });
});
