/**
 * RedisSessionChainStore tests
 * F24: Redis implementation of session chain store.
 * 有 Redis → 测全量；无 Redis → skip
 */

import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, it } from 'node:test';
import {
  assertRedisIsolationOrThrow,
  cleanupPrefixedRedisKeys,
  redisIsolationSkipReason,
} from './helpers/redis-test-helpers.js';

const REDIS_URL = process.env.REDIS_URL;

describe('RedisSessionChainStore', { skip: redisIsolationSkipReason(REDIS_URL) }, () => {
  let RedisSessionChainStore;
  let createRedisClient;
  let redis;
  let store;
  let connected = false;

  const SESSION_PATTERNS = [
    'session:*',
    'session-chain:*',
    'session-active:*',
    'session-cli:*',
    'session-by-chainkey:*',
  ];

  before(async () => {
    assertRedisIsolationOrThrow(REDIS_URL, 'RedisSessionChainStore');

    const storeModule = await import('../dist/domains/cats/services/stores/redis/RedisSessionChainStore.js');
    RedisSessionChainStore = storeModule.RedisSessionChainStore;
    const redisModule = await import('@cat-cafe/shared/utils');
    createRedisClient = redisModule.createRedisClient;

    redis = createRedisClient({ url: REDIS_URL });
    try {
      await redis.ping();
      connected = true;
    } catch {
      console.warn('[redis-session-chain-store.test] Redis unreachable, skipping tests');
      await redis.quit().catch(() => {});
      return;
    }
    store = new RedisSessionChainStore(redis);
  });

  after(async () => {
    if (redis && connected) {
      await cleanupPrefixedRedisKeys(redis, SESSION_PATTERNS);
      await redis.quit();
    }
  });

  beforeEach(async (t) => {
    if (!connected) return t.skip('Redis not connected');
    await cleanupPrefixedRedisKeys(redis, SESSION_PATTERNS);
  });

  const BASE_INPUT = {
    cliSessionId: 'cli-sess-1',
    threadId: 'thread-1',
    catId: 'opus',
    userId: 'user-1',
  };

  it('catHandoffNote round-trips through Redis intact (F225 A2)', async (t) => {
    if (!connected) return t.skip('Redis not connected');
    const record = await store.create(BASE_INPUT);
    const note = {
      proposalId: 'prop-1',
      sourceSessionId: record.id,
      done: 'wrote A2',
      worktreeBranch: 'feat/f225',
      commits: ['abc', 'def'],
      nextSteps: 'write B1',
      gotchas: 'commit-point irreversible',
      persistedAt: 12345,
    };
    await store.update(record.id, { catHandoffNote: note });
    const got = await store.get(record.id);
    // serialize/hydrate must preserve nested object + commits array (砚砚 feedback_inmemory)
    assert.deepEqual(got.catHandoffNote, note, 'catHandoffNote survives Redis serialize/hydrate');
  });

  it('create() returns SessionRecord with correct initial state', async () => {
    const record = await store.create(BASE_INPUT);

    assert.ok(record.id.length > 0);
    assert.equal(record.cliSessionId, 'cli-sess-1');
    assert.equal(record.threadId, 'thread-1');
    assert.equal(record.catId, 'opus');
    assert.equal(record.userId, 'user-1');
    assert.equal(record.seq, 0);
    assert.equal(record.status, 'active');
    assert.equal(record.messageCount, 0);
    assert.ok(record.createdAt > 0);
  });

  it('create() and update() preserve workspace binding metadata', async () => {
    const record = await store.create({
      ...BASE_INPUT,
      workingDirectory: '/repo-a',
      workspaceFingerprint: '/repo-a',
    });

    assert.equal(record.workingDirectory, '/repo-a');
    assert.equal(record.workspaceFingerprint, '/repo-a');

    await store.update(record.id, {
      workingDirectory: '/repo-b',
      workspaceFingerprint: '/repo-b',
    });

    const updated = await store.get(record.id);
    assert.equal(updated.workingDirectory, '/repo-b');
    assert.equal(updated.workspaceFingerprint, '/repo-b');
  });

  it('create() auto-increments seq for same cat+thread', async () => {
    const r0 = await store.create(BASE_INPUT);
    await store.update(r0.id, { status: 'sealed' });
    const r1 = await store.create({ ...BASE_INPUT, cliSessionId: 'cli-sess-2' });

    assert.equal(r0.seq, 0);
    assert.equal(r1.seq, 1);
  });

  it('create() returns the existing record for an already claimed cliSessionId', async () => {
    const first = await store.create(BASE_INPUT);
    const second = await store.create({ ...BASE_INPUT, threadId: 'thread-2', reuseExistingCliSession: true });

    assert.equal(second.id, first.id);
    assert.equal(second.threadId, 'thread-1');
    const firstChain = await store.getChain('opus', 'thread-1');
    const secondChain = await store.getChain('opus', 'thread-2');
    assert.equal(firstChain.length, 1);
    assert.equal(secondChain.length, 0);
  });

  it('create() creates a new record for duplicate cliSessionId unless reuse is requested', async () => {
    const first = await store.create(BASE_INPUT);
    const second = await store.create({ ...BASE_INPUT, threadId: 'thread-2' });

    assert.notEqual(second.id, first.id);
    const firstChain = await store.getChain('opus', 'thread-1');
    const secondChain = await store.getChain('opus', 'thread-2');
    assert.equal(firstChain.length, 1);
    assert.equal(secondChain.length, 1);
  });

  it('create() different cat starts at seq 0', async () => {
    await store.create(BASE_INPUT);
    const codexRecord = await store.create({ ...BASE_INPUT, catId: 'codex', cliSessionId: 'cli-codex-1' });
    assert.equal(codexRecord.seq, 0);
  });

  it('get() returns record by id', async () => {
    const created = await store.create(BASE_INPUT);
    const found = await store.get(created.id);

    assert.ok(found);
    assert.equal(found.id, created.id);
    assert.equal(found.catId, 'opus');
  });

  it('get() returns null for non-existent id', async () => {
    const result = await store.get('non-existent');
    assert.equal(result, null);
  });

  it('getActive() returns active session', async () => {
    const created = await store.create(BASE_INPUT);
    const active = await store.getActive('opus', 'thread-1');

    assert.ok(active);
    assert.equal(active.id, created.id);
    assert.equal(active.status, 'active');
  });

  it('getActive() returns null when no active session', async () => {
    const result = await store.getActive('opus', 'thread-1');
    assert.equal(result, null);
  });

  it('getActive() returns null after session is sealed', async () => {
    const created = await store.create(BASE_INPUT);
    await store.update(created.id, { status: 'sealed' });

    const result = await store.getActive('opus', 'thread-1');
    assert.equal(result, null);
  });

  it('getChain() returns sessions sorted by seq', async () => {
    const r0 = await store.create(BASE_INPUT);
    await store.update(r0.id, { status: 'sealed' });
    const r1 = await store.create({ ...BASE_INPUT, cliSessionId: 'cli-sess-2' });
    await store.update(r1.id, { status: 'sealed' });
    await store.create({ ...BASE_INPUT, cliSessionId: 'cli-sess-3' });

    const chain = await store.getChain('opus', 'thread-1');
    assert.equal(chain.length, 3);
    assert.equal(chain[0].seq, 0);
    assert.equal(chain[1].seq, 1);
    assert.equal(chain[2].seq, 2);
  });

  it('getChain() returns empty for unknown cat+thread', async () => {
    const chain = await store.getChain('opus', 'no-such-thread');
    assert.deepEqual(chain, []);
  });

  it('update() changes status and updatedAt', async () => {
    const record = await store.create(BASE_INPUT);
    const updated = await store.update(record.id, { status: 'sealing' });

    assert.ok(updated);
    assert.equal(updated.status, 'sealing');
    assert.ok(updated.updatedAt >= record.updatedAt);
  });

  it('update() stores contextHealth', async () => {
    const record = await store.create(BASE_INPUT);
    const health = {
      usedTokens: 50000,
      windowTokens: 200000,
      fillRatio: 0.25,
      source: 'exact',
      measuredAt: Date.now(),
    };

    const updated = await store.update(record.id, { contextHealth: health });
    assert.ok(updated);
    assert.deepEqual(updated.contextHealth, health);
  });

  it('update() persists continuityCapsule across hydrated lookup paths', async () => {
    const record = await store.create(BASE_INPUT);
    const capsule = {
      version: 1,
      source: 'route-state',
      boundary: 'compact',
      threadId: 'thread-1',
      catId: 'opus',
      mode: 'serial',
      directReplyToMessageId: 'msg-direct',
      a2a: {
        exitCheckRequired: true,
        nextMention: 'codex',
      },
      handoff: {
        fromCatId: 'opus',
        toCatId: 'codex',
        reason: 'review-ready',
      },
    };

    const updated = await store.update(record.id, { continuityCapsule: capsule });
    assert.ok(updated);
    assert.deepEqual(updated.continuityCapsule, capsule);

    const byId = await store.get(record.id);
    assert.deepEqual(byId.continuityCapsule, capsule);

    const active = await store.getActive('opus', 'thread-1');
    assert.deepEqual(active.continuityCapsule, capsule);

    const byCli = await store.getByCliSessionId('cli-sess-1');
    assert.deepEqual(byCli.continuityCapsule, capsule);
  });

  it('update() returns null for non-existent id', async () => {
    const result = await store.update('non-existent', { status: 'sealed' });
    assert.equal(result, null);
  });

  it('getByCliSessionId() returns correct record', async () => {
    const created = await store.create(BASE_INPUT);
    const found = await store.getByCliSessionId('cli-sess-1');

    assert.ok(found);
    assert.equal(found.id, created.id);
  });

  it('getByCliSessionId() returns null for unknown CLI session', async () => {
    const result = await store.getByCliSessionId('non-existent');
    assert.equal(result, null);
  });

  it('update() changes cliSessionId and updates index', async () => {
    const record = await store.create(BASE_INPUT);
    await store.update(record.id, { cliSessionId: 'cli-new' });

    const found = await store.getByCliSessionId('cli-new');
    assert.ok(found);
    assert.equal(found.id, record.id);

    const old = await store.getByCliSessionId('cli-sess-1');
    assert.equal(old, null, 'old CLI session ID should be unlinked');
  });

  it('getChainByThread() returns all cats sessions for a thread', async () => {
    await store.create(BASE_INPUT);
    await store.create({ ...BASE_INPUT, catId: 'codex', cliSessionId: 'cli-codex-1' });

    const all = await store.getChainByThread('thread-1');
    assert.equal(all.length, 2);
    const catIds = all.map((r) => r.catId);
    assert.ok(catIds.includes('opus'));
    assert.ok(catIds.includes('codex'));
  });

  it('sealed session sets sealReason and sealedAt', async () => {
    const record = await store.create(BASE_INPUT);
    const sealedAt = Date.now();
    await store.update(record.id, { status: 'sealed', sealReason: 'threshold', sealedAt });

    const sealed = await store.get(record.id);
    assert.equal(sealed.status, 'sealed');
    assert.equal(sealed.sealReason, 'threshold');
    assert.equal(sealed.sealedAt, sealedAt);
  });

  it('reactivated session restores active index and clears seal metadata', async () => {
    const record = await store.create(BASE_INPUT);
    const sealedAt = Date.now();
    await store.update(record.id, { status: 'sealed', sealReason: 'external_registration_failed', sealedAt });
    assert.equal(await store.getActive('opus', 'thread-1'), null);

    await store.update(record.id, { status: 'active', sealReason: null, sealedAt: null });

    const reopened = await store.get(record.id);
    assert.equal(reopened.status, 'active');
    assert.equal(reopened.sealReason, undefined);
    assert.equal(reopened.sealedAt, undefined);
    assert.equal((await store.getActive('opus', 'thread-1'))?.id, record.id);
  });

  // ── F198 Bug #3: chainKey stable conversation anchor (Redis-backed) ──

  it('create() persists chainKey and getByChainKey() reads it back', async () => {
    const created = await store.create({ ...BASE_INPUT, chainKey: 'bg:thread-1:opus' });
    assert.equal(created.chainKey, 'bg:thread-1:opus');
    const found = await store.getByChainKey('bg:thread-1:opus');
    assert.ok(found, 'should find record by chainKey');
    assert.equal(found.id, created.id);
    assert.equal(found.chainKey, 'bg:thread-1:opus');
  });

  it('getByChainKey() returns null for an unknown chainKey', async () => {
    await store.create({ ...BASE_INPUT, chainKey: 'bg:thread-1:opus' });
    assert.equal(await store.getByChainKey('bg:thread-2:opus'), null);
  });

  it('getByChainKey() returns the record even after it is sealed (write tolerance)', async () => {
    const created = await store.create({ ...BASE_INPUT, chainKey: 'bg:thread-1:opus' });
    await store.update(created.id, { status: 'sealed' });
    const found = await store.getByChainKey('bg:thread-1:opus');
    assert.ok(found, 'sealed record must still be reachable by chainKey');
    assert.equal(found.id, created.id);
    assert.equal(found.status, 'sealed');
  });

  it('getByChainKey() survives cliSessionId rotation (daemon fork)', async () => {
    // bg daemon forks a fresh sessionId every --resume round; chainKey must
    // remain the stable anchor so the same record is reused, not re-created.
    const created = await store.create({
      ...BASE_INPUT,
      cliSessionId: 'daemon-short-1',
      chainKey: 'bg:thread-1:opus',
    });
    await store.update(created.id, { cliSessionId: 'daemon-short-2' });
    await store.update(created.id, { cliSessionId: 'daemon-short-3' });
    const found = await store.getByChainKey('bg:thread-1:opus');
    assert.ok(found, 'chainKey index must survive cliSessionId rotation');
    assert.equal(found.id, created.id);
    assert.equal(found.cliSessionId, 'daemon-short-3');
  });

  it('update() persists latestResumeSessionId across hydration', async () => {
    const created = await store.create({ ...BASE_INPUT, chainKey: 'bg:thread-1:opus' });
    const uuid = '7c77a04d-1111-2222-3333-444455556666';
    await store.update(created.id, { latestResumeSessionId: uuid });
    const reread = await store.get(created.id);
    assert.equal(reread.latestResumeSessionId, uuid);
    assert.equal((await store.getByChainKey('bg:thread-1:opus')).latestResumeSessionId, uuid);
  });
});
