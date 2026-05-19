/**
 * RedisInvocationRecordStore tests
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

describe('RedisInvocationRecordStore', { skip: redisIsolationSkipReason(REDIS_URL) }, () => {
  let RedisInvocationRecordStore;
  let createRedisClient;
  let redis;
  let store;
  let connected = false;

  before(async () => {
    assertRedisIsolationOrThrow(REDIS_URL, 'RedisInvocationRecordStore');

    const storeModule = await import('../dist/domains/cats/services/stores/redis/RedisInvocationRecordStore.js');
    RedisInvocationRecordStore = storeModule.RedisInvocationRecordStore;
    const redisModule = await import('@cat-cafe/shared/utils');
    createRedisClient = redisModule.createRedisClient;

    redis = createRedisClient({ url: REDIS_URL });
    try {
      await redis.ping();
      connected = true;
    } catch {
      console.warn('[redis-invocation-record-store.test] Redis unreachable, skipping tests');
      await redis.quit().catch(() => {});
      return;
    }
    store = new RedisInvocationRecordStore(redis);
  });

  after(async () => {
    if (redis && connected) {
      await cleanupPrefixedRedisKeys(redis, ['invoc:*', 'idemp:*']);
      await redis.quit();
    }
  });

  beforeEach(async (t) => {
    if (!connected) return t.skip('Redis not connected');
    await cleanupPrefixedRedisKeys(redis, ['invoc:*', 'idemp:*']);
  });

  it('create() returns created outcome', async () => {
    const result = await store.create({
      threadId: 'thread-1',
      userId: 'user-1',
      targetCats: ['opus'],
      intent: 'execute',
      idempotencyKey: 'redis-key-1',
    });

    assert.equal(result.outcome, 'created');
    assert.ok(result.invocationId.length > 0);
  });

  it('create() record has correct initial state', async () => {
    const { invocationId } = await store.create({
      threadId: 'thread-1',
      userId: 'user-1',
      targetCats: ['opus', 'codex'],
      intent: 'ideate',
      idempotencyKey: 'redis-key-2',
    });

    const record = await store.get(invocationId);
    assert.ok(record);
    assert.equal(record.status, 'queued');
    assert.equal(record.userMessageId, null);
    assert.equal(record.threadId, 'thread-1');
    assert.equal(record.userId, 'user-1');
    assert.deepEqual(record.targetCats, ['opus', 'codex']);
    assert.equal(record.intent, 'ideate');
    assert.equal(record.idempotencyKey, 'redis-key-2');
    assert.equal(record.error, undefined);
  });

  it('Lua atomic dedup returns duplicate on same key', async () => {
    const first = await store.create({
      threadId: 'thread-1',
      userId: 'user-1',
      targetCats: ['opus'],
      intent: 'execute',
      idempotencyKey: 'dup-key',
    });
    assert.equal(first.outcome, 'created');

    const second = await store.create({
      threadId: 'thread-1',
      userId: 'user-1',
      targetCats: ['opus'],
      intent: 'execute',
      idempotencyKey: 'dup-key',
    });
    assert.equal(second.outcome, 'duplicate');
    assert.equal(second.invocationId, first.invocationId);
  });

  it('different threadId with same key does not dedup', async () => {
    const first = await store.create({
      threadId: 'thread-1',
      userId: 'user-1',
      targetCats: ['opus'],
      intent: 'execute',
      idempotencyKey: 'same-key',
    });
    const second = await store.create({
      threadId: 'thread-2',
      userId: 'user-1',
      targetCats: ['opus'],
      intent: 'execute',
      idempotencyKey: 'same-key',
    });

    assert.equal(first.outcome, 'created');
    assert.equal(second.outcome, 'created');
    assert.notEqual(first.invocationId, second.invocationId);
  });

  it('get() returns null for non-existent id', async () => {
    const result = await store.get('non-existent-id');
    assert.equal(result, null);
  });

  it('update() changes status', async () => {
    const { invocationId } = await store.create({
      threadId: 'thread-1',
      userId: 'user-1',
      targetCats: ['opus'],
      intent: 'execute',
      idempotencyKey: 'upd-key',
    });

    const updated = await store.update(invocationId, { status: 'running' });
    assert.equal(updated.status, 'running');
  });

  it('update() backfills userMessageId', async () => {
    const { invocationId } = await store.create({
      threadId: 'thread-1',
      userId: 'user-1',
      targetCats: ['opus'],
      intent: 'execute',
      idempotencyKey: 'backfill-key',
    });

    const before = await store.get(invocationId);
    assert.equal(before.userMessageId, null);

    await store.update(invocationId, { userMessageId: 'msg-456' });
    const after = await store.get(invocationId);
    assert.equal(after.userMessageId, 'msg-456');
  });

  it('update() sets error on failed status', async () => {
    const { invocationId } = await store.create({
      threadId: 'thread-1',
      userId: 'user-1',
      targetCats: ['opus'],
      intent: 'execute',
      idempotencyKey: 'err-key',
    });

    await store.update(invocationId, { status: 'running' });
    await store.update(invocationId, { status: 'failed', error: 'CLI ENOENT' });
    const record = await store.get(invocationId);
    assert.equal(record.status, 'failed');
    assert.equal(record.error, 'CLI ENOENT');
  });

  it('update() returns null for non-existent id', async () => {
    const result = await store.update('non-existent', { status: 'running' });
    assert.equal(result, null);
  });

  it('getByIdempotencyKey() finds record', async () => {
    const { invocationId } = await store.create({
      threadId: 'thread-1',
      userId: 'user-1',
      targetCats: ['opus'],
      intent: 'execute',
      idempotencyKey: 'lookup-key',
    });

    const found = await store.getByIdempotencyKey('thread-1', 'user-1', 'lookup-key');
    assert.ok(found);
    assert.equal(found.id, invocationId);
  });

  it('CAS update() succeeds when expectedStatus matches', async () => {
    const { invocationId } = await store.create({
      threadId: 'thread-1',
      userId: 'user-1',
      targetCats: ['opus'],
      intent: 'execute',
      idempotencyKey: 'cas-ok-key',
    });

    const result = await store.update(invocationId, {
      status: 'running',
      expectedStatus: 'queued',
    });
    assert.ok(result);
    assert.equal(result.status, 'running');
  });

  it('CAS update() returns null when expectedStatus mismatches', async () => {
    const { invocationId } = await store.create({
      threadId: 'thread-1',
      userId: 'user-1',
      targetCats: ['opus'],
      intent: 'execute',
      idempotencyKey: 'cas-fail-key',
    });

    const result = await store.update(invocationId, {
      status: 'running',
      expectedStatus: 'failed', // actual is 'queued'
    });
    assert.equal(result, null);

    // Status unchanged
    const record = await store.get(invocationId);
    assert.equal(record.status, 'queued');
  });

  it('concurrent CAS update: only one wins (Lua atomic)', async () => {
    const { invocationId } = await store.create({
      threadId: 'thread-1',
      userId: 'user-1',
      targetCats: ['opus'],
      intent: 'execute',
      idempotencyKey: 'cas-race-key',
    });

    // Transition through proper lifecycle: queued → running → failed (retry starts from failed)
    await store.update(invocationId, { status: 'running' });
    await store.update(invocationId, { status: 'failed', error: 'boom' });

    // Fire N concurrent CAS transitions: failed → running
    const N = 20;
    const results = await Promise.all(
      Array.from({ length: N }, () =>
        store.update(invocationId, {
          status: 'running',
          error: '',
          expectedStatus: 'failed',
        }),
      ),
    );

    const winners = results.filter((r) => r !== null);
    const losers = results.filter((r) => r === null);
    assert.equal(winners.length, 1, `Expected exactly 1 winner, got ${winners.length}`);
    assert.equal(losers.length, N - 1);
    assert.equal(winners[0].status, 'running');
  });

  it('non-CAS update rejects illegal transition atomically', async () => {
    const { invocationId } = await store.create({
      threadId: 'thread-1',
      userId: 'user-1',
      targetCats: ['opus'],
      intent: 'execute',
      idempotencyKey: 'guard-no-cas',
    });

    // queued → running → succeeded (terminal)
    await store.update(invocationId, { status: 'running' });
    await store.update(invocationId, { status: 'succeeded' });

    // succeeded → failed is illegal, must be rejected
    const result = await store.update(invocationId, { status: 'failed', error: 'should not happen' });
    assert.equal(result, null);

    const record = await store.get(invocationId);
    assert.equal(record.status, 'succeeded');
    assert.equal(record.error, undefined);
  });

  it('same-status update on terminal state is rejected (cloud P1)', async () => {
    // Reproduces cloud Codex P1: succeeded→succeeded bypassed state machine
    // because Lua only checked transitions when newStatus ~= current.
    const { invocationId } = await store.create({
      threadId: 'thread-1',
      userId: 'user-1',
      targetCats: ['opus'],
      intent: 'execute',
      idempotencyKey: 'self-transition',
    });

    await store.update(invocationId, { status: 'running' });
    await store.update(invocationId, { status: 'succeeded' });

    // succeeded → succeeded should be rejected (terminal, no self-transitions)
    const result = await store.update(invocationId, { status: 'succeeded', error: 'late error' });
    assert.equal(result, null);

    const record = await store.get(invocationId);
    assert.equal(record.status, 'succeeded');
    assert.equal(record.error, undefined);
  });

  it('concurrent non-CAS updates cannot regress terminal state (race regression)', async () => {
    // Reproduces the P1 bug: concurrent non-CAS writes could bypass state machine.
    // Before fix: hget(status) → validate → hset was non-atomic, allowing
    // a stale read to overwrite a newer terminal status.
    const { invocationId } = await store.create({
      threadId: 'thread-1',
      userId: 'user-1',
      targetCats: ['opus'],
      intent: 'execute',
      idempotencyKey: 'race-no-cas',
    });

    // Get to running state
    await store.update(invocationId, { status: 'running' });

    // Fire concurrent: one tries succeeded, another tries failed
    // Both are legal from running, but only one should win.
    // The loser's transition should be rejected (not silently applied).
    const [r1, r2] = await Promise.all([
      store.update(invocationId, { status: 'succeeded' }),
      store.update(invocationId, { status: 'failed', error: 'late failure' }),
    ]);

    const record = await store.get(invocationId);

    if (r1 !== null) {
      // succeeded won — failed must have been rejected (succeeded is terminal)
      assert.equal(record.status, 'succeeded');
      assert.equal(record.error, undefined);
    } else {
      // failed won — succeeded must have been rejected (failed is not terminal, but
      // the point is: final state must be consistent with one atomic transition)
      assert.equal(record.status, 'failed');
      assert.ok(r2 !== null);
    }

    // Key invariant: exactly one winner
    const winners = [r1, r2].filter((r) => r !== null);
    assert.equal(winners.length, 1, 'Exactly one concurrent update should succeed');
  });

  it('getByIdempotencyKey() returns null for wrong scope', async () => {
    await store.create({
      threadId: 'thread-1',
      userId: 'user-1',
      targetCats: ['opus'],
      intent: 'execute',
      idempotencyKey: 'scoped-key',
    });

    const r1 = await store.getByIdempotencyKey('thread-2', 'user-1', 'scoped-key');
    assert.equal(r1, null);
    const r2 = await store.getByIdempotencyKey('thread-1', 'user-2', 'scoped-key');
    assert.equal(r2, null);
  });

  it('F194 Phase B — listRunningByThread is index-backed (SMEMBERS, not SCAN)', async (t) => {
    if (!connected) return t.skip('Redis not connected');
    // Create + transition to running
    const r1 = await store.create({
      threadId: 'thread-A',
      userId: 'user-1',
      targetCats: ['opus'],
      intent: 'execute',
      idempotencyKey: 'list-r1',
    });
    const r2 = await store.create({
      threadId: 'thread-A',
      userId: 'user-1',
      targetCats: ['opus'],
      intent: 'execute',
      idempotencyKey: 'list-r2',
    });
    const r3 = await store.create({
      threadId: 'thread-A',
      userId: 'user-2', // different user
      targetCats: ['opus'],
      intent: 'execute',
      idempotencyKey: 'list-r3',
    });

    await store.update(r1.invocationId, { status: 'running' });
    await store.update(r2.invocationId, { status: 'running' });
    await store.update(r2.invocationId, { status: 'succeeded' }); // exits running
    await store.update(r3.invocationId, { status: 'running' });

    const running = await store.listRunningByThread('thread-A', 'user-1');
    const ids = running.map((r) => r.id).sort();
    assert.deepEqual(ids, [r1.invocationId].sort(), 'only r1 (running + thread-A + user-1) returned');

    // Verify index actually used: the running set should contain just r1's id under user-1
    const setKey = `cat-cafe:invoc:running:thread-A:user-1`; // matches keyPrefix + InvocationKeys.runningByThread
    const setMembers = await redis.smembers('invoc:running:thread-A:user-1'); // ioredis auto-prefix
    assert.deepEqual(setMembers.sort(), [r1.invocationId].sort(), 'index Set tracks only running r1');
    void setKey;
  });

  it('F194 Phase B — defensive filter cleans stale Set members', async (t) => {
    if (!connected) return t.skip('Redis not connected');
    const r = await store.create({
      threadId: 'thread-X',
      userId: 'user-Y',
      targetCats: ['opus'],
      intent: 'execute',
      idempotencyKey: 'stale-key',
    });

    // Inject stale member directly into the index (simulate update→Set race or external corruption)
    await redis.sadd('invoc:running:thread-X:user-Y', 'fake-stale-id');
    // Real record is queued, not running
    const setBefore = await redis.smembers('invoc:running:thread-X:user-Y');
    assert.ok(setBefore.includes('fake-stale-id'));

    // listRunningByThread filters defensively + cleans up
    const running = await store.listRunningByThread('thread-X', 'user-Y');
    assert.equal(running.length, 0, 'queued record + fake stale id both filtered');

    // Allow the fire-and-forget SREM to complete
    await new Promise((resolve) => setTimeout(resolve, 50));
    const setAfter = await redis.smembers('invoc:running:thread-X:user-Y');
    assert.equal(setAfter.includes('fake-stale-id'), false, 'stale id was cleaned up');
    void r;
  });

  it('F194 Phase B (cloud R13 P1) — backfill running index for pre-deploy records', async (t) => {
    if (!connected) return t.skip('Redis not connected');
    // Reproduces cloud Codex P1: pre-deploy `running` records aren't in the
    // `invoc:running:{tid}:{uid}` Set because the Set is only populated on
    // future status transitions in update(). Without backfill, a fresh deploy's
    // listRunningByThread returns [] for these orphaned records.
    //
    // Simulate by writing a record directly via HSET (bypasses create+update),
    // verify the Set is empty, then assert listRunningByThread surfaces it
    // anyway (lazy backfill path).

    // Inject a "pre-deploy" running record straight into Redis (no SADD)
    const preDeployId = 'pre-deploy-running-1';
    await redis.hset(`invoc:${preDeployId}`, {
      id: preDeployId,
      threadId: 'thread-PD',
      userId: 'user-PD',
      targetCats: '["opus"]',
      intent: 'execute',
      idempotencyKey: 'pre-deploy-key',
      status: 'running',
      userMessageId: '',
      error: '',
      createdAt: String(Date.now() - 10_000),
      updatedAt: String(Date.now() - 10_000),
    });

    // Sanity: Set is empty (no SADD was triggered for this record)
    const setBefore = await redis.smembers('invoc:running:thread-PD:user-PD');
    assert.equal(setBefore.length, 0, 'pre-deploy record absent from Set');

    // ⚠️ Use a fresh store instance so the per-process backfill flag isn't already set
    const freshStore = new RedisInvocationRecordStore(redis);
    const running = await freshStore.listRunningByThread('thread-PD', 'user-PD');
    const ids = running.map((r) => r.id);
    assert.deepEqual(ids, [preDeployId], 'pre-deploy running record surfaced via backfill');

    // Set is now populated (backfill side-effect)
    const setAfter = await redis.smembers('invoc:running:thread-PD:user-PD');
    assert.deepEqual(setAfter.sort(), [preDeployId].sort(), 'index populated after backfill');
  });

  it('F194 Phase B (cloud R13 P1) — backfill is one-time per process', async (t) => {
    if (!connected) return t.skip('Redis not connected');
    // Once backfilled, a second listRunningByThread on a different (tid,uid) must
    // NOT re-scan: behavior is observable by injecting a record post-backfill,
    // skipping update(), and asserting it does NOT surface (because no SADD).
    const freshStore = new RedisInvocationRecordStore(redis);

    // First call triggers backfill (Set empty + no records → trivial backfill)
    await freshStore.listRunningByThread('thread-Z', 'user-Z');

    // Inject a post-backfill orphan; backfill should NOT re-run
    const orphanId = 'post-backfill-orphan-1';
    await redis.hset(`invoc:${orphanId}`, {
      id: orphanId,
      threadId: 'thread-Z',
      userId: 'user-Z',
      targetCats: '["opus"]',
      intent: 'execute',
      idempotencyKey: 'orphan-key',
      status: 'running',
      userMessageId: '',
      error: '',
      createdAt: String(Date.now()),
      updatedAt: String(Date.now()),
    });

    const running = await freshStore.listRunningByThread('thread-Z', 'user-Z');
    assert.equal(running.length, 0, 'orphan injected after backfill is NOT resurrected');
  });

  it('F194 Phase B (cloud R16 P2) — backfill skips invoc:running:* set keys (no wasted HGETALL)', async (t) => {
    if (!connected) return t.skip('Redis not connected');
    // Reproduces cloud Codex P2 (comment 3211824356, line 395): SCAN MATCH=invoc:*
    // matches both record hashes (invoc:{uuid}) and running-set keys
    // (invoc:running:{tid}:{uid}). Without filtering, backfill HGETALLs the set keys
    // too — wasted round trips on first read. Verify backfill ONLY pipelines HGETALL
    // for record hashes by counting hgetall pipeline calls under controlled state.

    // Setup: mix of record hashes + running-set keys
    const recordId = 'r16-record-1';
    await redis.hset(`invoc:${recordId}`, {
      id: recordId,
      threadId: 'r16-T',
      userId: 'r16-U',
      targetCats: '["opus"]',
      intent: 'execute',
      idempotencyKey: 'r16-key',
      status: 'running',
      userMessageId: '',
      error: '',
      createdAt: String(Date.now()),
      updatedAt: String(Date.now()),
    });
    // Pre-existing running-set key (matches SCAN MATCH=invoc:*)
    await redis.sadd('invoc:running:other-T:other-U', 'placeholder-id');

    // Wrap redis.pipeline to count hgetall calls
    const origPipeline = redis.pipeline.bind(redis);
    const hgetallTargetKeys = [];
    redis.pipeline = (...args) => {
      const p = origPipeline(...args);
      const origHgetall = p.hgetall.bind(p);
      p.hgetall = (key) => {
        hgetallTargetKeys.push(key);
        return origHgetall(key);
      };
      return p;
    };

    try {
      const freshStore = new RedisInvocationRecordStore(redis);
      const running = await freshStore.listRunningByThread('r16-T', 'r16-U');
      assert.deepEqual(
        running.map((r) => r.id),
        [recordId],
        'pre-deploy record surfaced via backfill',
      );
    } finally {
      redis.pipeline = origPipeline;
    }

    // Critical assertion: backfill HGETALL must NOT have targeted any invoc:running:* key
    const setKeyHgetalls = hgetallTargetKeys.filter((k) => k.startsWith('invoc:running:'));
    assert.equal(
      setKeyHgetalls.length,
      0,
      `backfill must not HGETALL running-set keys (saw: ${JSON.stringify(setKeyHgetalls)})`,
    );
    // And it should have HGETALL'd at least the record hash
    const recordHgetalls = hgetallTargetKeys.filter((k) => k === `invoc:${recordId}`);
    assert.ok(recordHgetalls.length > 0, 'backfill must HGETALL the record hash');
  });

  it('F194 Phase B (cloud R13 P1 #2) — update() converges Set membership when userId changes mid-flight', async (t) => {
    if (!connected) return t.skip('Redis not connected');
    // Reproduces cloud Codex P1 #2 (comment 3209482070): update() derives setKey
    // from a pre-read snapshot of (threadId, userId). If reassignUserId() runs between
    // the snapshot and EVAL, the Lua applies SADD/SREM to the WRONG running set, leaving
    // a live invocation either stranded in the old set or missing from the new one.
    //
    // Test orchestrates the race by wrapping redis.eval to inject a userId change +
    // Set migration AFTER the JS-side snapshot read but BEFORE the actual EVAL fires.
    // Fix should detect (threadId, userId) drift inside Lua and retry with fresh setKey.

    // Setup: queued record under user-A
    const r = await store.create({
      threadId: 'thread-race',
      userId: 'user-A',
      targetCats: ['opus'],
      intent: 'execute',
      idempotencyKey: 'race-key',
    });
    await store.update(r.invocationId, { status: 'running' });

    // Sanity: record is in user-A's running set
    const setA = await redis.smembers('invoc:running:thread-race:user-A');
    let setB = await redis.smembers('invoc:running:thread-race:user-B');
    assert.deepEqual(setA, [r.invocationId]);
    assert.equal(setB.length, 0);

    // Race injection: wrap eval so the FIRST eval call simulates reassignUserId
    // having migrated the record to user-B between get() and EVAL.
    const origEval = redis.eval.bind(redis);
    let injected = false;
    redis.eval = async (...args) => {
      if (!injected) {
        injected = true;
        // Atomic-ish reassignUserId simulation: HSET userId + migrate Set membership
        await redis.hset(`invoc:${r.invocationId}`, 'userId', 'user-B');
        await redis.srem('invoc:running:thread-race:user-A', r.invocationId);
        await redis.sadd('invoc:running:thread-race:user-B', r.invocationId);
      }
      return origEval(...args);
    };

    try {
      // Trigger the race: transition running → succeeded.
      // Without fix: setKey passed to Lua is "thread-race:user-A" (stale). Lua does
      // SREM there (no-op, already migrated) → record left in user-B's set despite
      // being succeeded. Defensive filter masks but membership is wrong.
      // With fix: Lua detects threadId/userId mismatch (returns -3), JS retries with
      // fresh setKey "thread-race:user-B" → SREM correctly applied.
      await store.update(r.invocationId, { status: 'succeeded' });
    } finally {
      redis.eval = origEval;
    }

    // Final state: record succeeded, NOT in user-B's running set
    const finalRecord = await store.get(r.invocationId);
    assert.equal(finalRecord.status, 'succeeded', 'status transitioned to succeeded');

    setB = await redis.smembers('invoc:running:thread-race:user-B');
    assert.equal(
      setB.includes(r.invocationId),
      false,
      'fix: record removed from current owner (user-B) set on terminal transition',
    );
  });

  it('F194 Phase B — reassignUserId migrates running Set membership', async (t) => {
    if (!connected) return t.skip('Redis not connected');
    const r = await store.create({
      threadId: 'thread-T',
      userId: 'user-old',
      targetCats: ['opus'],
      intent: 'execute',
      idempotencyKey: 'reassign-key',
    });
    await store.update(r.invocationId, { status: 'running' });

    // Sanity: in old Set
    const oldBefore = await redis.smembers('invoc:running:thread-T:user-old');
    assert.deepEqual(oldBefore.sort(), [r.invocationId].sort());

    await store.reassignUserId(r.invocationId, 'user-new');

    const oldAfter = await redis.smembers('invoc:running:thread-T:user-old');
    const newAfter = await redis.smembers('invoc:running:thread-T:user-new');
    assert.equal(oldAfter.includes(r.invocationId), false, 'removed from old user Set');
    assert.deepEqual(newAfter.sort(), [r.invocationId].sort(), 'added to new user Set');

    // listRunningByThread reflects migration
    const oldList = await store.listRunningByThread('thread-T', 'user-old');
    const newList = await store.listRunningByThread('thread-T', 'user-new');
    assert.equal(oldList.length, 0);
    assert.equal(newList.length, 1);
  });

  it('F194 Phase B (cloud R14 P1) — reassignUserId Set migration is atomic (no SREM-only crash window)', async (t) => {
    if (!connected) return t.skip('Redis not connected');
    // Reproduces cloud Codex P1 (comment 3211498998): old reassignUserId did
    // HSET userId → SREM oldSet → SADD newSet as 3 separate awaits. A crash
    // (process exit / Redis network glitch) between SREM and SADD would leave
    // a running record in NEITHER set — invisible to listRunningByThread for
    // either old or new owner, breaking canonical liveness.
    //
    // Test: wrap redis.eval to count Lua invocations during reassignUserId.
    // The fix folds HSET + SREM + SADD into a single Lua eval, so a single eval
    // call must atomically achieve the final state. Compare oldSet/newSet
    // BEFORE and AFTER the eval — they must transition together (no intermediate
    // state observable from a wrapper).

    const r = await store.create({
      threadId: 'thread-atomic',
      userId: 'user-A',
      targetCats: ['opus'],
      intent: 'execute',
      idempotencyKey: 'atomic-key',
    });
    await store.update(r.invocationId, { status: 'running' });

    // Wrap eval to assert the atomic invariant: at the moment the migration Lua
    // runs, oldSet should still have the record (pre-state), and after eval
    // returns, oldSet should NOT have it AND newSet SHOULD have it (post-state).
    const origEval = redis.eval.bind(redis);
    let migrationEvalSeen = false;
    let observedAtomicTransition = false;
    redis.eval = async (script, ...rest) => {
      // Detect the migration eval by script content (single-purpose script
      // distinct from ATOMIC_UPDATE_LUA for status updates)
      const isMigration =
        typeof script === 'string' &&
        script.includes('SREM') &&
        script.includes('SADD') &&
        !script.includes('newStatus');
      if (isMigration && !migrationEvalSeen) {
        migrationEvalSeen = true;
        const preOld = await origEval(
          'return redis.call("SMEMBERS", KEYS[1])',
          1,
          'invoc:running:thread-atomic:user-A',
        );
        const preNew = await origEval(
          'return redis.call("SMEMBERS", KEYS[1])',
          1,
          'invoc:running:thread-atomic:user-B',
        );
        const result = await origEval(script, ...rest);
        const postOld = await origEval(
          'return redis.call("SMEMBERS", KEYS[1])',
          1,
          'invoc:running:thread-atomic:user-A',
        );
        const postNew = await origEval(
          'return redis.call("SMEMBERS", KEYS[1])',
          1,
          'invoc:running:thread-atomic:user-B',
        );
        // Atomic invariant: pre had old, not new; post has new, not old (both transitions in one eval)
        observedAtomicTransition =
          preOld.includes(r.invocationId) &&
          !preNew.includes(r.invocationId) &&
          !postOld.includes(r.invocationId) &&
          postNew.includes(r.invocationId);
        return result;
      }
      return origEval(script, ...rest);
    };

    try {
      await store.reassignUserId(r.invocationId, 'user-B');
    } finally {
      redis.eval = origEval;
    }

    assert.equal(migrationEvalSeen, true, 'reassignUserId must use a Lua eval for Set migration');
    assert.equal(
      observedAtomicTransition,
      true,
      'Set migration must complete in a single Lua eval — pre: old=[id], new=[]; post: old=[], new=[id]',
    );

    // Final sanity: state correct
    const oldFinal = await redis.smembers('invoc:running:thread-atomic:user-A');
    const newFinal = await redis.smembers('invoc:running:thread-atomic:user-B');
    assert.equal(oldFinal.includes(r.invocationId), false);
    assert.deepEqual(newFinal.sort(), [r.invocationId].sort());
  });

  it('F194 Phase B (cloud R14 P1) — reassignUserId skips Set migration when status drifted to terminal', async (t) => {
    if (!connected) return t.skip('Redis not connected');
    // Edge case: if status transitions running → succeeded between snapshot and Lua,
    // the migration must read CURRENT status inside Lua and skip Set migration
    // (terminal records should not be in any running set).

    const r = await store.create({
      threadId: 'thread-drift',
      userId: 'user-A',
      targetCats: ['opus'],
      intent: 'execute',
      idempotencyKey: 'drift-key',
    });
    await store.update(r.invocationId, { status: 'running' });

    // Wrap eval: between snapshot and migration Lua, transition record to succeeded
    // (this simulates a concurrent update() winning the race). The migration Lua
    // must then read current status='succeeded' and skip Set migration.
    const origEval = redis.eval.bind(redis);
    redis.eval = async (script, ...rest) => {
      const isMigration =
        typeof script === 'string' &&
        script.includes('SREM') &&
        script.includes('SADD') &&
        !script.includes('newStatus');
      if (isMigration) {
        // Inject status transition right before the migration Lua fires
        // (use HSET directly to bypass update()'s Lua and just change status)
        await redis.hset(`invoc:${r.invocationId}`, 'status', 'succeeded');
        // Record was in user-A's set; simulate update()'s SREM that would happen
        await redis.srem('invoc:running:thread-drift:user-A', r.invocationId);
      }
      return origEval(script, ...rest);
    };

    try {
      await store.reassignUserId(r.invocationId, 'user-B');
    } finally {
      redis.eval = origEval;
    }

    // After: record is succeeded with userId=user-B. Neither running set should have it.
    const finalRecord = await store.get(r.invocationId);
    assert.equal(finalRecord.status, 'succeeded');
    assert.equal(finalRecord.userId, 'user-B');

    const setA = await redis.smembers('invoc:running:thread-drift:user-A');
    const setB = await redis.smembers('invoc:running:thread-drift:user-B');
    assert.equal(setA.includes(r.invocationId), false, 'user-A set must not contain succeeded record');
    assert.equal(setB.includes(r.invocationId), false, 'user-B set must not contain succeeded record');
  });
});
