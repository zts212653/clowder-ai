import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, it } from 'node:test';
import {
  assertRedisIsolationOrThrow,
  cleanupPrefixedRedisKeys,
  redisIsolationSkipReason,
} from './helpers/redis-test-helpers.js';

const REDIS_URL = process.env.REDIS_URL;

const { RedisFreshnessClosureStore } = await import(
  '../dist/domains/cats/services/freshness/RedisFreshnessClosureStore.js'
);
const { FreshnessClosureKeys } = await import(
  '../dist/domains/cats/services/stores/redis-keys/freshness-closure-keys.js'
);

const scope = { userId: 'user-1', threadId: 'thread-1', catId: 'codex-sol' };

function openInput(overrides = {}) {
  return {
    closureId: 'closure-1',
    ...scope,
    invocationId: 'inv-base',
    originTriggerMessageId: 'msg-origin-1',
    draftContent: 'stale draft',
    requiredMessageIds: ['msg-2'],
    requiredFrontierMessageId: 'msg-2',
    observedRawFrontierMessageId: 'msg-2',
    now: 100,
    ...overrides,
  };
}

describe('RedisFreshnessClosureStore', { skip: redisIsolationSkipReason(REDIS_URL) }, () => {
  let redis;
  let store;
  let connected = false;

  before(async () => {
    assertRedisIsolationOrThrow(REDIS_URL, 'RedisFreshnessClosureStore');
    const { createRedisClient } = await import('@cat-cafe/shared/utils');
    redis = createRedisClient({ url: REDIS_URL });
    try {
      await redis.ping();
      connected = true;
      store = new RedisFreshnessClosureStore(redis);
    } catch {
      await redis.quit().catch(() => {});
    }
  });

  beforeEach(async (t) => {
    if (!connected) return t.skip('Redis not connected');
    await cleanupPrefixedRedisKeys(redis, ['freshness:closure:*']);
  });

  after(async () => {
    if (!connected) return;
    await cleanupPrefixedRedisKeys(redis, ['freshness:closure:*']);
    await redis.quit();
  });

  it('IR-3 persists multiple lineages per scope without merging their drafts', async () => {
    const [first, second] = await Promise.all([
      store.openOrAdvance(openInput()),
      store.openOrAdvance(
        openInput({
          closureId: 'closure-race',
          invocationId: 'inv-race',
          originTriggerMessageId: 'msg-origin-2',
          draftContent: 'newer stale',
          requiredMessageIds: ['msg-3'],
          requiredFrontierMessageId: 'msg-3',
          observedRawFrontierMessageId: 'msg-3',
          now: 110,
        }),
      ),
    ]);
    assert.deepEqual([first.id, second.id].sort(), ['closure-1', 'closure-race']);
    const active = await store.listActiveByScope(scope);
    assert.deepEqual(active.map((closure) => closure.id).sort(), ['closure-1', 'closure-race']);
    assert.deepEqual((await store.get(first.id)).requiredMessageIds, ['msg-2']);
    assert.deepEqual((await store.get(second.id)).requiredMessageIds, ['msg-3']);
    assert.equal(await redis.ttl(FreshnessClosureKeys.detail(first.id)), -1);
    assert.equal(await redis.ttl(FreshnessClosureKeys.lineages(scope)), -1);
  });

  it('IR-12 atomically grants one running lease across concurrent lineages', async () => {
    const first = await store.openOrAdvance(openInput());
    const second = await store.openOrAdvance(
      openInput({
        closureId: 'closure-2',
        invocationId: 'inv-base-2',
        originTriggerMessageId: 'msg-origin-2',
        draftContent: 'second stale',
        requiredMessageIds: ['msg-3'],
        requiredFrontierMessageId: 'msg-3',
        observedRawFrontierMessageId: 'msg-3',
      }),
    );
    const claims = await Promise.allSettled([
      store.claimAttempt(first.id, {
        invocationId: 'inv-successor-1',
        inputFrontierMessageId: 'msg-2',
        observedRawFrontierMessageId: 'msg-2',
        now: 200,
      }),
      store.claimAttempt(second.id, {
        invocationId: 'inv-successor-2',
        inputFrontierMessageId: 'msg-3',
        observedRawFrontierMessageId: 'msg-3',
        now: 200,
      }),
    ]);
    assert.equal(claims.filter((claim) => claim.status === 'fulfilled').length, 1);
    assert.equal(claims.filter((claim) => claim.status === 'rejected').length, 1);
    const winner = claims[0].status === 'fulfilled' ? claims[0].value : claims[1].value;
    const loser = winner.id === first.id ? second : first;
    assert.equal(await redis.get(FreshnessClosureKeys.runningLease(scope)), winner.id);

    const committed = await store.commit(winner.id, {
      invocationId: winner.activeAttempt.invocationId,
      messageId: 'final-1',
      observedRawFrontierMessageId: winner.observedRawFrontierMessageId,
      draftContent: 'fresh final',
      now: 300,
    });
    assert.equal(committed.status, 'committed');
    assert.equal(await redis.get(FreshnessClosureKeys.runningLease(scope)), null);
    assert.deepEqual(
      (await store.listActiveByScope(scope)).map((closure) => closure.id),
      [loser.id],
    );

    const runningLoser = await store.claimAttempt(loser.id, {
      invocationId: 'inv-successor-after-release',
      inputFrontierMessageId: loser.requiredFrontierMessageId,
      observedRawFrontierMessageId: loser.observedRawFrontierMessageId,
      now: 400,
    });
    assert.equal(runningLoser.status, 'running');
  });

  it('migrates the legacy single active pointer into the lineage set without losing a running lease', async () => {
    const opened = await store.openOrAdvance(openInput({ closureId: 'closure-legacy-running' }));
    const running = await store.claimAttempt(opened.id, {
      invocationId: 'inv-legacy-successor',
      inputFrontierMessageId: opened.requiredFrontierMessageId,
      observedRawFrontierMessageId: opened.observedRawFrontierMessageId,
      now: 200,
    });
    await redis.del(FreshnessClosureKeys.lineages(scope), FreshnessClosureKeys.runningLease(scope));
    await redis.set(FreshnessClosureKeys.activeScope(scope), running.id);

    const migrated = await store.listActiveByScope(scope);

    assert.deepEqual(
      migrated.map((closure) => closure.id),
      [running.id],
    );
    assert.deepEqual(await redis.smembers(FreshnessClosureKeys.lineages(scope)), [running.id]);
    assert.equal(await redis.get(FreshnessClosureKeys.runningLease(scope)), running.id);
    assert.equal(await redis.get(FreshnessClosureKeys.activeScope(scope)), null);
    assert.equal(await redis.ttl(FreshnessClosureKeys.detail(running.id)), -1);
  });

  it('persists supersede/commit with CAS inside one explicit lineage', async () => {
    const opened = await store.openOrAdvance(openInput());
    const running = await store.claimAttempt(opened.id, {
      invocationId: 'inv-successor',
      inputFrontierMessageId: 'msg-2',
      observedRawFrontierMessageId: 'msg-2',
      now: 200,
    });
    assert.equal(running.status, 'running');
    const pending = await store.supersedeAttempt(opened.id, {
      invocationId: 'inv-successor',
      draftContent: 'also stale',
      requiredMessageIds: ['msg-3'],
      requiredFrontierMessageId: 'msg-3',
      observedRawFrontierMessageId: 'msg-3',
      evidenceRefs: ['event-1'],
      now: 300,
    });
    const runningAgain = await store.claimAttempt(pending.id, {
      invocationId: 'inv-successor-2',
      inputFrontierMessageId: 'msg-3',
      observedRawFrontierMessageId: 'msg-3',
      now: 400,
    });
    const committed = await store.commit(runningAgain.id, {
      invocationId: 'inv-successor-2',
      messageId: 'final-1',
      observedRawFrontierMessageId: 'msg-3',
      draftContent: 'fresh final',
      now: 500,
    });
    assert.equal(committed.status, 'committed');
    assert.deepEqual(await store.listActiveByScope(scope), []);
    assert.equal((await store.get(opened.id)).committedMessageId, 'final-1');
    assert.equal(await redis.ttl(FreshnessClosureKeys.detail(opened.id)), -1);
  });

  it('IR-10 persists preflight frontier refresh and fail-closed evidence with CAS', async () => {
    const opened = await store.openOrAdvance(openInput());
    const refreshed = await store.refreshFrontier(opened.id, {
      requiredMessageIds: ['msg-2', 'msg-4'],
      requiredFrontierMessageId: 'msg-4',
      observedRawFrontierMessageId: 'msg-5',
      now: 200,
    });
    assert.deepEqual(refreshed.requiredMessageIds, ['msg-2', 'msg-4']);
    assert.equal(refreshed.observedRawFrontierMessageId, 'msg-5');

    const blocked = await store.blockPreflight(opened.id, {
      evidenceRefs: ['raw-frontier:incomplete:msg-5:msg-6'],
      now: 300,
    });
    assert.equal(blocked.status, 'blocked');
    assert.equal(blocked.blockedReason, 'freshness_preflight_incomplete');
    assert.deepEqual(blocked.blockedEvidenceRefs, ['raw-frontier:incomplete:msg-5:msg-6']);
    assert.equal(await redis.ttl(FreshnessClosureKeys.detail(opened.id)), -1);
  });

  it('persists a replay fence without TTL and retains its evidence across explicit retry', async () => {
    const blocked = await store.openOrAdvance(
      openInput({ replayUnsafeToolNames: ['mcp__cat-cafe-collab__cat_cafe_hold_ball'] }),
    );
    assert.equal(blocked.status, 'blocked');
    assert.equal(blocked.blockedReason, 'side_effect_requires_explicit_retry');
    assert.deepEqual(blocked.replayUnsafeToolNames, ['mcp__cat-cafe-collab__cat_cafe_hold_ball']);
    assert.equal(await redis.ttl(FreshnessClosureKeys.detail(blocked.id)), -1);

    const retried = await store.retry(blocked.id, {
      actorId: 'user-1',
      evidenceRef: 'retry-click',
      now: 200,
    });
    assert.equal(retried.status, 'pending');
    assert.deepEqual(retried.replayUnsafeToolNames, blocked.replayUnsafeToolNames);
  });

  it('persists a startup recovery block without TTL and keeps it hydratable', async () => {
    const opened = await store.openOrAdvance(openInput({ closureId: 'closure-startup-blocked' }));
    const blocked = await store.blockRecovery(opened.id, {
      evidenceRefs: ['startup:pending_requires_explicit_retry'],
      now: 200,
    });

    assert.equal(blocked.status, 'blocked');
    assert.equal(blocked.blockedReason, 'startup_recovery_requires_explicit_retry');
    assert.deepEqual(blocked.blockedEvidenceRefs, ['startup:pending_requires_explicit_retry']);
    assert.equal(await redis.ttl(FreshnessClosureKeys.detail(blocked.id)), -1);
    assert.equal((await store.listActiveByThread(scope.threadId)).at(-1).id, blocked.id);
    assert.deepEqual(await store.listRecoverable(), []);
  });

  it('CAS-terminalizes a fully-accounted legacy closure and removes only its active hydration index', async () => {
    const migratedCandidate = await store.openOrAdvance(
      openInput({
        closureId: 'closure-legacy-migrated',
        replayUnsafeToolNames: ['Edit'],
      }),
    );
    const unresolved = await store.openOrAdvance(
      openInput({
        closureId: 'closure-legacy-unresolved',
        catId: 'opus48',
        replayUnsafeToolNames: ['Edit'],
      }),
    );
    const input = {
      expectedRevision: migratedCandidate.revision,
      actorId: 'f254-migration',
      evidenceRef: 'migration-manifest',
      manifestSha256: 'a'.repeat(64),
      accountingSha256: 'b'.repeat(64),
      invocationIds: ['invocation-legacy-final'],
      messageIds: ['message-legacy-final'],
      evidenceRefs: ['migration-manifest', 'transcript:legacy-final'],
      outcomeCounts: {
        already_formal_exact: 0,
        already_recovered_exact: 1,
        no_text: 0,
      },
      now: 300,
    };

    const [first, concurrentRerun] = await Promise.all([
      store.migrateLegacy(migratedCandidate.id, input),
      store.migrateLegacy(migratedCandidate.id, input),
    ]);
    assert.equal(first.status, 'disposed');
    assert.equal(first.disposition.kind, 'legacy_migrated');
    assert.equal(concurrentRerun.revision, first.revision);
    assert.deepEqual(
      (await store.listAllActive()).map((closure) => closure.id),
      [unresolved.id],
    );
    assert.deepEqual(
      (await store.listActiveByThread(scope.threadId)).map((closure) => closure.id),
      [unresolved.id],
    );
    assert.equal(await redis.ttl(FreshnessClosureKeys.detail(migratedCandidate.id)), -1);

    await assert.rejects(
      store.migrateLegacy(migratedCandidate.id, { ...input, manifestSha256: 'c'.repeat(64) }),
      /different legacy migration/i,
    );
  });

  it('cascades thread deletion across details and active indexes', async () => {
    await store.openOrAdvance(openInput());
    await store.openOrAdvance(openInput({ closureId: 'closure-2', catId: 'opus48' }));
    assert.equal(await store.deleteByThread(scope.threadId), 2);
    assert.deepEqual(await store.listActiveByThread(scope.threadId), []);
  });
});
