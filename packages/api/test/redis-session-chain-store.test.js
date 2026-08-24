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
  let SessionSealer;
  let createRedisClient;
  let redis;
  let store;
  let connected = false;

  const SESSION_PATTERNS = [
    'session:*',
    'session-chain:*',
    'session-chain-by-thread:*',
    'session-active:*',
    'session-cli:*',
    'session-by-chainkey:*',
  ];

  before(async () => {
    assertRedisIsolationOrThrow(REDIS_URL, 'RedisSessionChainStore');

    const storeModule = await import('../dist/domains/cats/services/stores/redis/RedisSessionChainStore.js');
    RedisSessionChainStore = storeModule.RedisSessionChainStore;
    ({ SessionSealer } = await import('../dist/domains/cats/services/session/SessionSealer.js'));
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

  it('#1382 shrinkCapacityPin never lets a delayed larger candidate undo a smaller pin', async (t) => {
    if (!connected) return t.skip('Redis not connected');
    const record = await store.create(BASE_INPUT);
    const pin = (windowTokens, inputCeilingTokens) => ({
      windowTokens,
      inputCeilingTokens,
      source: 'reported',
      provenance: `Carrier reported ${windowTokens.toLocaleString()} tokens`,
      actionable: true,
    });

    // First write lands (no usable pin stored yet).
    await store.shrinkCapacityPin(record.id, pin(200_000, 184_000));
    assert.equal((await store.get(record.id))?.capacityPin?.windowTokens, 200_000);

    // Maintainer probe ordering: the 150K constraint lands, then the delayed
    // 180K candidate must be refused by the Lua compare-and-write.
    await store.shrinkCapacityPin(record.id, pin(150_000, 134_000));
    await store.shrinkCapacityPin(record.id, pin(180_000, 164_000));
    const final = (await store.get(record.id))?.capacityPin;
    assert.equal(final?.windowTokens, 150_000, 'delayed larger candidate must not overwrite the smaller pin');
    assert.equal(final?.provenance, 'Carrier reported 150,000 tokens');

    // Equal candidate still lands (refreshes provenance), smaller lands too.
    await store.shrinkCapacityPin(record.id, pin(150_000, 134_000));
    await store.shrinkCapacityPin(record.id, pin(120_000, 104_000));
    assert.equal((await store.get(record.id))?.capacityPin?.windowTokens, 120_000);

    // Missing record → null, and no hash may be created as a side effect.
    assert.equal(await store.shrinkCapacityPin('missing-session-id', pin(150_000, 134_000)), null);
    assert.equal(await store.get('missing-session-id'), null);
  });

  it('#1382 appendCapacityPinProvenance merges onto the current pin and dedups', async (t) => {
    if (!connected) return t.skip('Redis not connected');
    const record = await store.create(BASE_INPUT);
    const note = '; carrier now reports 245,480 tokens — seal the session to recover if this pin was polluted';
    const pin = (windowTokens, inputCeilingTokens) => ({
      windowTokens,
      inputCeilingTokens,
      source: 'reported',
      provenance: `Carrier reported ${windowTokens.toLocaleString()} tokens`,
      actionable: true,
    });

    // The shrink lands before the delayed note write: the note must merge
    // onto the CURRENT 150K pin, never restoring the stale 200K object.
    await store.update(record.id, { capacityPin: pin(200_000, 184_000) });
    await store.update(record.id, { capacityPin: pin(150_000, 134_000) });
    await store.appendCapacityPinProvenance(record.id, note);
    let current = (await store.get(record.id))?.capacityPin;
    assert.equal(current?.windowTokens, 150_000);
    assert.ok(current?.provenance?.includes('seal the session to recover'));

    // Dedup: the identical note is not re-appended.
    await store.appendCapacityPinProvenance(record.id, note);
    current = (await store.get(record.id))?.capacityPin;
    assert.equal(current?.provenance?.match(/seal the session to recover/g)?.length, 1);

    // Semantic dedup: a jittered report number replaces the note in place —
    // one pin carries at most one recovery instruction.
    const jitteredNote = '; carrier now reports 245,481 tokens — seal the session to recover if this pin was polluted';
    await store.appendCapacityPinProvenance(record.id, jitteredNote);
    current = (await store.get(record.id))?.capacityPin;
    assert.equal(current?.windowTokens, 150_000);
    assert.equal(current?.provenance?.match(/seal the session to recover/g)?.length, 1);
    assert.ok(current?.provenance?.includes('245,481'), 'latest report number wins');
    assert.ok(!current?.provenance?.includes('245,480'), 'stale report number replaced');

    // No stored pin → null, nothing written.
    const bare = await store.create({ ...BASE_INPUT, cliSessionId: 'cli-sess-bare' });
    assert.equal(await store.appendCapacityPinProvenance(bare.id, note), null);
    assert.equal((await store.get(bare.id))?.capacityPin, undefined);
  });

  it('#1329 atomically creates one unbound logical node and binds it later', async () => {
    const input = {
      threadId: 'thread-logical',
      catId: 'opus',
      userId: 'user-1',
      compressionCount: null,
    };
    const [first, second] = await Promise.all([store.getOrCreateActive(input), store.getOrCreateActive(input)]);
    assert.equal(first.id, second.id);
    assert.equal(first.cliSessionId, undefined);
    assert.equal(first.compressionCount, null);
    assert.equal((await store.getChain('opus', 'thread-logical')).length, 1);

    const bound = await store.bindCliSessionId(first.id, 'cli-late');
    assert.equal(bound.id, first.id);
    assert.equal((await store.getByCliSessionId('cli-late')).id, first.id);
  });

  it('#1329 accepts exactly one concurrent seal transition', async () => {
    const record = await store.create({
      cliSessionId: 'cli-concurrent-seal',
      threadId: 'thread-concurrent-seal',
      catId: 'opus',
      userId: 'user-1',
    });
    const sealer = new SessionSealer(store);
    const results = await Promise.all(
      Array.from({ length: 12 }, () => sealer.requestSeal({ sessionId: record.id, reason: 'threshold' })),
    );

    assert.equal(
      results.filter((result) => result.accepted).length,
      1,
      'active -> sealing must be a store-owned CAS transition',
    );
  });

  it('#1329 refuses an atomic seal from a superseded policy revision', async () => {
    const record = await store.create({
      cliSessionId: 'cli-revision-seal',
      threadId: 'thread-revision-seal',
      catId: 'opus',
      userId: 'user-1',
    });
    await store.applyPolicySnapshot(record.id, {
      config: { strategy: 'compress', thresholds: { warn: 0.75, action: 0.85 } },
      source: 'runtime_override',
      revision: 'revision-new',
      changedAt: 2,
      execution: { status: 'active', missingCapabilities: [] },
    });

    assert.equal(await store.transitionToSealing(record.id, 'max_compressions', 'revision-old'), null);
    assert.equal((await store.get(record.id)).status, 'active');
    assert.equal((await store.getActive('opus', 'thread-revision-seal', 'user-1')).id, record.id);
  });

  it('#1329 atomically isolates logical active ownership by user on a shared thread', async () => {
    const ownerA = { threadId: 'default', catId: 'opus', userId: 'user-a', compressionCount: null };
    const ownerB = { threadId: 'default', catId: 'opus', userId: 'user-b', compressionCount: null };

    const [firstA, firstB] = await Promise.all([store.getOrCreateActive(ownerA), store.getOrCreateActive(ownerB)]);
    const [secondA, secondB] = await Promise.all([store.getOrCreateActive(ownerA), store.getOrCreateActive(ownerB)]);

    assert.notEqual(firstA.id, firstB.id);
    assert.equal(firstA.seq, 0);
    assert.equal(firstB.seq, 0);
    assert.equal(secondA.id, firstA.id);
    assert.equal(secondB.id, firstB.id);
    assert.equal((await store.getActive('opus', 'default', 'user-a')).id, firstA.id);
    assert.equal((await store.getActive('opus', 'default', 'user-b')).id, firstB.id);
    assert.equal((await store.getChain('opus', 'default', 'user-a')).length, 1);
    assert.equal((await store.getChain('opus', 'default', 'user-b')).length, 1);

    await store.update(firstA.id, { status: 'sealed' });
    const nextA = await store.getOrCreateActive({ ...ownerA, cliSessionId: 'cli-owner-a-next' });
    assert.equal(nextA.seq, 1);
  });

  it('#1329 repairs a stale owner-active pointer instead of reviving a sealed record', async () => {
    const input = { threadId: 'default', catId: 'opus', userId: 'user-a', compressionCount: null };
    const sealed = await store.getOrCreateActive(input);
    await store.update(sealed.id, { status: 'sealed', sealedAt: Date.now() });
    await redis.set('session-active:opus:default:owner:user-a', sealed.id);

    const replacement = await store.getOrCreateActive(input);

    assert.notEqual(replacement.id, sealed.id);
    assert.equal(replacement.status, 'active');
    assert.equal((await store.get(sealed.id)).status, 'sealed');
  });

  it('#1329 sealing compare-deletes active pointers without erasing a concurrent replacement', async () => {
    const old = await store.create({
      cliSessionId: 'cli-pointer-old',
      threadId: 'thread-pointer-race',
      catId: 'opus',
      userId: 'user-a',
    });
    const replacement = await store.create({
      cliSessionId: 'cli-pointer-new',
      threadId: 'thread-pointer-race',
      catId: 'opus',
      userId: 'user-a',
    });
    const keys = new Set([
      'session-active:opus:thread-pointer-race',
      'session-active:opus:thread-pointer-race:owner:user-a',
    ]);
    for (const key of keys) await redis.set(key, old.id);

    const originalGet = redis.get.bind(redis);
    const originalEval = redis.eval.bind(redis);
    redis.get = async (key, ...args) => {
      const value = await originalGet(key, ...args);
      if (keys.has(key) && value === old.id) await redis.set(key, replacement.id);
      return value;
    };
    redis.eval = async (script, numberOfKeys, key, ...args) => {
      if (keys.has(key) && typeof script === 'string' && script.includes("redis.call('GET', KEYS[1]) == ARGV[1]")) {
        await redis.set(key, replacement.id);
      }
      return originalEval(script, numberOfKeys, key, ...args);
    };
    try {
      await store.update(old.id, { status: 'sealed' });
    } finally {
      redis.get = originalGet;
      redis.eval = originalEval;
    }

    for (const key of keys) assert.equal(await redis.get(key), replacement.id);
    assert.equal((await store.getActive('opus', 'thread-pointer-race', 'user-a')).id, replacement.id);
  });

  it('#1329 adopts a pre-owner-index active record without creating a duplicate', async () => {
    const input = {
      cliSessionId: 'cli-legacy-owner-index',
      threadId: 'default',
      catId: 'opus',
      userId: 'user-a',
      compressionCount: null,
    };
    const legacy = await store.create(input);
    await redis.del('session-active:opus:default:owner:user-a');

    const adopted = await store.getOrCreateActive(input);

    assert.equal(adopted.id, legacy.id);
    assert.equal((await store.getChain('opus', 'default', 'user-a')).length, 1);
  });

  it('#1329 late binding cannot steal a runtime ID from another logical node', async () => {
    const logical = await store.getOrCreateActive({
      threadId: 'thread-logical-conflict',
      catId: 'opus',
      userId: 'user-1',
      compressionCount: null,
    });
    const owner = await store.create({
      cliSessionId: 'cli-owned',
      threadId: 'thread-owner',
      catId: 'codex',
      userId: 'user-1',
    });

    assert.equal(await store.bindCliSessionId(logical.id, 'cli-owned'), null);
    assert.equal((await store.getByCliSessionId('cli-owned')).id, owner.id);
    assert.equal((await store.get(logical.id)).cliSessionId, undefined);
  });

  it('#1329 keeps unknown lifetime telemetry separate from revision-local hybrid progress', async () => {
    const logical = await store.getOrCreateActive({
      threadId: 'thread-progress',
      catId: 'opus',
      userId: 'user-1',
      compressionCount: null,
    });
    const snapshot = {
      config: { strategy: 'hybrid', thresholds: { warn: 0.75, action: 0.85 }, hybrid: { maxCompressions: 2 } },
      source: 'runtime_override',
      revision: 'revision-a',
      changedAt: 10,
      execution: { status: 'active', missingCapabilities: [] },
    };
    await store.applyPolicySnapshot(logical.id, snapshot);

    const [one, two] = await Promise.all([
      store.recordCompressionEvent(logical.id, 'revision-a'),
      store.recordCompressionEvent(logical.id, 'revision-a'),
    ]);
    assert.deepEqual([one.hybridProgress.observedCount, two.hybridProgress.observedCount].sort(), [1, 2]);
    const reread = await store.get(logical.id);
    assert.equal(reread.compressionCount, null);
    assert.equal(reread.hybridProgress.observedCount, 2);

    await store.applyPolicySnapshot(logical.id, { ...snapshot, revision: 'revision-b', changedAt: 20 });
    const reset = await store.get(logical.id);
    assert.equal(reset.hybridProgress.policyRevision, 'revision-b');
    assert.equal(reset.hybridProgress.observedCount, 0);
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

  it('update() persists capacityPin across hydrated lookup paths', async () => {
    const record = await store.create(BASE_INPUT);
    const capacityPin = {
      windowTokens: 200_000,
      inputCeilingTokens: 184_000,
      source: 'reported',
      provenance: 'Carrier reported 200,000 tokens',
      actionable: true,
    };

    const updated = await store.update(record.id, { capacityPin });
    assert.ok(updated);
    assert.deepEqual(updated.capacityPin, capacityPin);

    const freshStore = new RedisSessionChainStore(redis);
    assert.deepEqual((await freshStore.get(record.id)).capacityPin, capacityPin);
    assert.deepEqual((await freshStore.getActive('opus', 'thread-1')).capacityPin, capacityPin);
    assert.deepEqual((await freshStore.getByCliSessionId('cli-sess-1')).capacityPin, capacityPin);
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

  it('create() maintains the per-thread chain-key index', async () => {
    await store.create(BASE_INPUT);
    await store.create({ ...BASE_INPUT, catId: 'codex', cliSessionId: 'cli-codex-1' });

    assert.deepEqual((await redis.smembers('session-chain-by-thread:thread-1')).sort(), [
      'session-chain:codex:thread-1',
      'session-chain:opus:thread-1',
    ]);
  });

  it('backfills legacy chain keys once, then reads every thread without another global SCAN', async () => {
    const legacyId = 'legacy-session-1';
    await redis.zadd('session-chain:opus:legacy-thread', 0, legacyId);
    await redis.hset(
      `session:${legacyId}`,
      'id',
      legacyId,
      'cliSessionId',
      'legacy-cli-1',
      'threadId',
      'legacy-thread',
      'catId',
      'opus',
      'userId',
      'user-1',
      'seq',
      '0',
      'status',
      'sealed',
      'messageCount',
      '1',
      'createdAt',
      '1',
      'updatedAt',
      '2',
    );

    const originalScanStream = redis.scanStream.bind(redis);
    let globalScans = 0;
    redis.scanStream = (...args) => {
      globalScans += 1;
      return originalScanStream(...args);
    };
    try {
      const freshStore = new RedisSessionChainStore(redis);
      const legacy = await freshStore.getChainByThread('legacy-thread');
      const missing = await freshStore.getChainByThread('missing-thread');

      assert.equal(legacy.length, 1);
      assert.equal(legacy[0].id, legacyId);
      assert.deepEqual(missing, []);
      assert.equal(globalScans, 1, 'all later thread reads must use the index instead of scanning Redis again');
      assert.deepEqual(await redis.smembers('session-chain-by-thread:legacy-thread'), [
        'session-chain:opus:legacy-thread',
      ]);
    } finally {
      redis.scanStream = originalScanStream;
    }
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

  it('restoreActiveSession() atomically restores the selected record in place and preserves the displaced record', async () => {
    const target = await store.create({
      ...BASE_INPUT,
      cliSessionId: 'cli-restore-target',
      threadId: 'thread-restore-current',
    });
    await store.update(target.id, {
      status: 'sealed',
      sealReason: 'cli_session_replaced',
      sealedAt: Date.now(),
      messageCount: 3,
    });
    const current = await store.create({
      ...BASE_INPUT,
      cliSessionId: 'cli-restore-current',
      threadId: 'thread-restore-current',
    });
    await store.update(current.id, { messageCount: 7 });

    const result = await store.restoreActiveSession({
      targetSessionId: target.id,
      expectedActiveSessionId: current.id,
      displacedSealReason: 'manual_session_switch',
    });

    assert.equal(result.status, 'restored');
    assert.equal(result.session.id, target.id);
    assert.equal(result.session.seq, 0);
    assert.equal(result.displacedSessionId, current.id);
    assert.equal((await store.getActive('opus', 'thread-restore-current', 'user-1')).id, target.id);

    const restoredTarget = await store.get(target.id);
    assert.equal(restoredTarget.status, 'active');
    assert.equal(restoredTarget.sealReason, undefined);
    assert.equal(restoredTarget.sealedAt, undefined);
    assert.equal(restoredTarget.messageCount, 3);

    const displaced = await store.get(current.id);
    assert.equal(displaced.status, 'sealing');
    assert.equal(displaced.sealReason, 'manual_session_switch');
    assert.equal(displaced.messageCount, 7);

    const chain = await store.getChain('opus', 'thread-restore-current', 'user-1');
    assert.deepEqual(
      chain.map(({ id, seq }) => ({ id, seq })),
      [
        { id: target.id, seq: 0 },
        { id: current.id, seq: 1 },
      ],
      'restoring must not create a replacement sequence record',
    );
  });

  it('restoreActiveSession() rejects a stale expected active ID without mutating either record', async () => {
    const target = await store.create({
      ...BASE_INPUT,
      cliSessionId: 'cli-restore-cas-target',
      threadId: 'thread-restore-cas',
    });
    await store.update(target.id, {
      status: 'sealed',
      sealReason: 'cli_session_replaced',
      sealedAt: Date.now(),
    });
    const current = await store.create({
      ...BASE_INPUT,
      cliSessionId: 'cli-restore-cas-current',
      threadId: 'thread-restore-cas',
    });

    const result = await store.restoreActiveSession({
      targetSessionId: target.id,
      expectedActiveSessionId: 'stale-active-session-id',
      displacedSealReason: 'manual_session_switch',
    });

    assert.deepEqual(result, { status: 'active_changed', activeSessionId: current.id });
    assert.equal((await store.get(target.id)).status, 'sealed');
    assert.equal((await store.get(current.id)).status, 'active');
    assert.equal((await store.getActive('opus', 'thread-restore-cas', 'user-1')).id, current.id);
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
