/**
 * F167 carrier refresh on the real Redis InvocationRecord and TurnExecution stores.
 *
 * The production 409 `execution_unconfirmed` (lease 72bf1545, handled on 2026-09-24) came from how long
 * evidence lives: the idempotency index is created with a 5-minute expiry while the parent record is
 * persistent. This pins that on the real store, and that the child ledger custody points into is persistent
 * too, then shows the recognition still confirms the old run once the index is gone. Custody names the CHILD
 * turn, so the proof is followed child -> parent through the durable ledger. The key is shortened with PEXPIRE
 * instead of waiting 5 minutes; the real expiry is asserted separately so the shortcut cannot hide a changed
 * constant.
 */
import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, it } from 'node:test';
import {
  assertRedisIsolationOrThrow,
  cleanupPrefixedRedisKeys,
  redisIsolationSkipReason,
} from './helpers/redis-test-helpers.js';

const REDIS_URL = process.env.REDIS_URL;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const KEY_PATTERNS = ['invoc:*', 'invoc-terminal:*', 'idemp:*', 'turnexec:*'];

describe('F167 refresh execution evidence (real Redis)', { skip: redisIsolationSkipReason(REDIS_URL) }, () => {
  let redis;
  let store;
  let turns;
  let keys;
  let turnKeys;
  let resolveCarrier;
  let fixtures;
  let connected = false;

  before(async () => {
    assertRedisIsolationOrThrow(REDIS_URL, 'F167 refresh execution evidence');
    const { RedisInvocationRecordStore } = await import(
      '../dist/domains/cats/services/stores/redis/RedisInvocationRecordStore.js'
    );
    const { RedisTurnExecutionStore } = await import(
      '../dist/domains/cats/services/stores/redis/RedisTurnExecutionStore.js'
    );
    ({ InvocationKeys: keys } = await import('../dist/domains/cats/services/stores/redis-keys/invocation-keys.js'));
    ({ TurnExecutionKeys: turnKeys } = await import(
      '../dist/domains/cats/services/stores/redis-keys/turn-execution-keys.js'
    ));
    ({ resolveDirectActionSuccessorCarrier: resolveCarrier } = await import(
      '../dist/domains/ball-custody/DirectActionSuccessorCarrierRecovery.js'
    ));
    fixtures = await import('./helpers/direct-action-carrier-fixtures.js');
    const { createRedisClient } = await import('@cat-cafe/shared/utils');
    redis = createRedisClient({ url: REDIS_URL });
    try {
      await redis.ping();
      connected = true;
    } catch {
      console.warn('[redis-action-carrier-execution-evidence.test] Redis unreachable, skipping tests');
      await redis.quit().catch(() => {});
      return;
    }
    store = new RedisInvocationRecordStore(redis);
    turns = new RedisTurnExecutionStore(redis);
  });

  after(async () => {
    if (redis && connected) {
      await cleanupPrefixedRedisKeys(redis, KEY_PATTERNS);
      await redis.quit();
    }
  });

  beforeEach(async (t) => {
    if (!connected) return t.skip('Redis not connected');
    await cleanupPrefixedRedisKeys(redis, KEY_PATTERNS);
  });

  /** What the Queue creates: a PARENT record from the carrier key, and the cat's turn as a CHILD of it. */
  async function succeededRun(current, { key = fixtures.oldInvocationKey(current, 'codex-sol') } = {}) {
    const created = await store.create({
      threadId: current.holderThreadId,
      userId: current.tenantScope,
      targetCats: ['codex-sol'],
      intent: 'execute',
      idempotencyKey: key,
      actionLeaseCarrier: { kind: 'action_successor', leaseId: current.leaseId, generation: current.generation },
    });
    const childId = `child-of-${created.invocationId}`;
    await turns.createRunning({
      invocationId: childId,
      parentInvocationId: created.invocationId,
      threadId: current.holderThreadId,
      userId: current.tenantScope,
      catId: 'codex-sol',
      executionKind: 'ordinary',
      startedAt: Date.now(),
    });
    await turns.transitionTerminal(childId, { status: 'succeeded', endedAt: Date.now() });
    await store.update(created.invocationId, { status: 'running' });
    await store.update(created.invocationId, { status: 'succeeded', successfulCatIds: ['codex-sol'] });
    return {
      key,
      parentId: created.invocationId,
      childId,
      indexKey: keys.idempotency(current.holderThreadId, current.tenantScope, key),
    };
  }

  function resolveWith(current, run) {
    const message = fixtures.carrier(current, 'codex-sol', 'handled');
    message.queueCustody.targetAttempts[0].invocationId = run.childId;
    return resolveCarrier({
      lease: current,
      admissionInput: fixtures.request(current),
      messageStore: { getByThreadAfter: async () => [message] },
      invocationRecordStore: store,
      turnExecutionStore: turns,
    });
  }

  it('the index carries a 5-minute expiry; the parent record and the child ledger entry have none', async () => {
    const run = await succeededRun(fixtures.lease());
    const indexTtl = await redis.ttl(run.indexKey);
    assert.ok(indexTtl > 0 && indexTtl <= 300, `idempotency index expires within 5 minutes (ttl=${indexTtl})`);
    assert.equal(await redis.ttl(keys.detail(run.parentId)), -1, 'the parent InvocationRecord does not expire');
    assert.equal(await redis.ttl(turnKeys.record(run.childId)), -1, 'the child ledger entry does not expire');
  });

  it('once the index has expired the parent is still there, and the old run is still confirmed through the child', async () => {
    const current = fixtures.lease();
    const run = await succeededRun(current);

    await redis.pexpire(run.indexKey, 50);
    await sleep(200);

    assert.equal(await store.getByIdempotencyKey(current.holderThreadId, current.tenantScope, run.key), null);
    assert.equal((await store.get(run.parentId))?.status, 'succeeded', 'the parent is not gone');
    assert.equal(await store.get(run.childId), null, 'custody names the child, which is no InvocationRecord');

    assert.equal((await resolveWith(current, run)).disposition, 'refresh_handled');
  });

  it('the lineage is not trusted blindly: a parent created from another key does not confirm this carrier', async () => {
    const current = fixtures.lease();
    const other = fixtures.lease({ generation: 2, revision: 9 });
    const run = await succeededRun(current, { key: fixtures.oldInvocationKey(other, 'codex-sol') });
    assert.deepEqual(await resolveWith(current, run), {
      disposition: 'unavailable',
      reason: 'execution_unconfirmed',
    });
  });
});
