import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, it } from 'node:test';
import {
  assertRedisIsolationOrThrow,
  cleanupPrefixedRedisKeys,
  redisIsolationSkipReason,
} from './helpers/redis-test-helpers.js';

const REDIS_URL = process.env.REDIS_URL;

/**
 * Redis parity for #1398.
 *
 * The in-memory suite proves the *contract*; it cannot prove the Redis backend honours it. The two
 * halves are implemented differently on purpose: in memory the receipt is a compensating write that
 * is retracted on rollback, on Redis it is an `HSET` inside the same Lua transition as the rows.
 * A verdict that only ever ran in memory would leave the Lua receipt comparison — the thing that
 * actually decides whether a settled key can be reused in production — completely unobserved.
 *
 * So this file runs the same envelopes through the same harness with both stores swapped for their
 * Redis implementations, and asserts the same outcomes.
 */
describe('#1398 private input idempotency on Redis', { skip: redisIsolationSkipReason(REDIS_URL) }, () => {
  let redis;
  let connectorDeliveryHarness;
  let RedisQueueLedgerStore;
  let RedisMessageStore;
  let threadSeq = 0;

  before(async () => {
    assertRedisIsolationOrThrow(REDIS_URL, '#1398 private input idempotency on Redis');
    const { createRedisClient } = await import('@cat-cafe/shared/utils');
    ({ connectorDeliveryHarness } = await import('./helpers/connector-delivery-harness.js'));
    ({ RedisQueueLedgerStore } = await import(
      '../dist/domains/cats/services/agents/invocation/queue-ledger/RedisQueueLedgerStore.js'
    ));
    ({ RedisMessageStore } = await import('../dist/domains/cats/services/stores/redis/RedisMessageStore.js'));
    redis = createRedisClient({ url: REDIS_URL });
    await redis.ping();
  });

  after(async () => {
    if (!redis) return;
    await cleanupPrefixedRedisKeys(redis, ['queue:*', 'msg:*', 'thread:*']);
    await redis.quit();
  });

  beforeEach(async () => {
    await cleanupPrefixedRedisKeys(redis, ['queue:*', 'msg:*', 'thread:*']);
  });

  /** Both halves are swapped together: the receipt lives in the ledger, the notice in the store. */
  const redisHarness = () =>
    connectorDeliveryHarness({
      messageStore: new RedisMessageStore(redis),
      ledgerStore: new RedisQueueLedgerStore(redis),
    });

  const nextThreadId = () => `thread-1398-redis-${(threadSeq += 1)}`;

  const deliver = (connector, threadId, overrides = {}) =>
    connector.delivery.deliverPrivate({
      ownerUserId: 'user-1',
      threadId,
      targetCatId: 'opus',
      idempotencyKey: 'eval-receipt-stable-key',
      content: 'run the scheduled eval',
      from: { kind: 'system', service: 'scheduler' },
      sourceCategory: 'scheduled',
      ...overrides,
    });

  /** Cross the processing boundary so only the receipt — not a live row — can answer the replay. */
  const retireFirstAdmission = async (connector, threadId, entryId) => {
    await connector.queue.markProcessingDurable(threadId, 'user-1', { entryId, targetCats: ['opus'] });
    await connector.queue.commitClaimedAdoptionDurable(threadId, 'user-1', entryId, 'opus', 'invocation-1', Date.now());
    assert.equal(await connector.queue.getDurableEntry(threadId, entryId), null, 'row retired');
  };

  const settledKey = async (connector) => {
    const threadId = nextThreadId();
    const first = await deliver(connector, threadId);
    assert.equal(first.admitted, true, 'the first admission succeeds');
    await retireFirstAdmission(connector, threadId, first.entryId);
    return threadId;
  };

  it('refuses a different payload that reuses a retired key instead of reporting it admitted', async () => {
    const connector = redisHarness();
    const threadId = await settledKey(connector);

    await assert.rejects(
      () => deliver(connector, threadId, { content: 'delete the production index' }),
      /identity conflict/i,
      'the Lua receipt comparison must reach the same verdict a live row would',
    );
    assert.equal(connector.progressed.length, 1, 'the conflicting envelope must not start work');
  });

  it('refuses a different target that reuses a retired key', async () => {
    const connector = redisHarness();
    const threadId = await settledKey(connector);

    await assert.rejects(
      () => deliver(connector, threadId, { targetCatId: 'codex' }),
      /identity conflict/i,
      'redirecting settled work to another cat is a conflict',
    );
    assert.equal(connector.progressed.length, 1, 'and no second wake is issued');
  });

  it('refuses an escalated owner provenance that reuses a retired key', async () => {
    const connector = redisHarness();
    const threadId = nextThreadId();

    const first = await deliver(connector, threadId, { ownerAuthProvenance: 'unknown' });
    await retireFirstAdmission(connector, threadId, first.entryId);

    await assert.rejects(
      () => deliver(connector, threadId, { ownerAuthProvenance: 'strict' }),
      /identity conflict/i,
      'a settled key must not be a way to upgrade authority after the fact',
    );
  });

  it('still replays the identical envelope after retirement', async () => {
    const connector = redisHarness();
    const threadId = await settledKey(connector);

    const replay = await deliver(connector, threadId);
    assert.equal(replay.admitted, true, 'the unchanged envelope is a replay, not a conflict');
    assert.equal(connector.progressed.length, 1, 'and it does not run the work again');
    assert.deepEqual(await connector.queue.listAllDurable(threadId), [], 'a replay queues nothing new');
  });

  const noticeFor = (threadId) => ({
    from: { kind: 'system', service: 'scheduler' },
    userId: 'user-1',
    content: 'Scheduled task triggered.',
    mentions: [],
    origin: 'callback',
    timestamp: Date.now(),
    threadId,
    source: { connector: 'scheduler', label: 'Scheduler' },
  });

  const deliverVisible = (connector, threadId, overrides = {}) =>
    connector.delivery.deliverVisibleWithPrivateInput({
      ownerUserId: 'user-1',
      threadId,
      targetCatId: 'opus',
      idempotencyKey: 'scheduled-wake:private',
      content: 'run the scheduled eval',
      from: { kind: 'system', service: 'scheduler' },
      sourceCategory: 'scheduled',
      notice: noticeFor(threadId),
      ...overrides,
    });

  it('admits the work and publishes the notice in one transition', async () => {
    const connector = redisHarness();
    const threadId = nextThreadId();

    const result = await deliverVisible(connector, threadId);

    assert.equal(result.admitted, true);
    assert.ok(result.notice, 'the visible line is published');
    assert.ok(await connector.messageStore.getById(result.notice.id), 'and it is durable in Redis');
    const rows = await connector.queue.listAllDurable(threadId);
    assert.equal(rows.length, 1, 'exactly one private row backs the notice');
    assert.equal(rows[0].kind, 'private_input', 'and it is private work, not a second History member');
    assert.equal(connector.progressed.length, 1, 'the announced work actually runs');
  });

  /**
   * The Redis half-commit a crash would otherwise expose: the notice write and the admission are
   * one transition, so an admission the ledger refuses must not leave a published "triggered" line
   * behind. There is no window to crash in, and this is what proves it — the refusal is driven by
   * the receipt, which is the only survivor once the row is gone.
   */
  it('publishes no notice when the admission half is refused', async () => {
    const connector = redisHarness();
    const threadId = nextThreadId();

    const first = await deliverVisible(connector, threadId);
    assert.equal(first.admitted, true);
    await retireFirstAdmission(connector, threadId, first.entryId);
    const afterFirst = await connector.messageStore.getByThreadIncludingQueued(threadId);

    await assert.rejects(
      () => deliverVisible(connector, threadId, { content: 'delete the production index' }),
      /identity conflict/i,
      'a changed envelope on a settled key must be refused, not published',
    );

    assert.deepEqual(
      (await connector.messageStore.getByThreadIncludingQueued(threadId)).map((m) => m.id),
      afterFirst.map((m) => m.id),
      'a refused admission must not leave a visible notice announcing work that never queued',
    );
    assert.deepEqual(await connector.queue.listAllDurable(threadId), [], 'and no durable work survives it');
    assert.equal(connector.progressed.length, 1, 'only the original admission ever ran');
  });

  /**
   * The same refusal, one step earlier in the row's life.
   *
   * The case above retires the first admission first, so the receipt is the only survivor and the
   * Lua receipt comparison decides. While the row is still LIVE the verdict used to short-circuit
   * on its mere existence and answer `settled` without ever comparing the envelope — so a
   * different payload reusing the key got past the preflight, the notice was published, and only
   * a TypeScript check afterwards raised the conflict. By then the thread already showed a
   * "triggered" line for work that was refused, which is precisely the half-commit the single
   * transition exists to make impossible.
   */
  it('publishes no notice when a live row is reused by a different envelope', async () => {
    const connector = redisHarness();
    const threadId = nextThreadId();

    const first = await deliverVisible(connector, threadId);
    assert.equal(first.admitted, true);
    assert.ok(
      await connector.queue.getDurableEntry(threadId, first.entryId),
      'the row must still be live — this case is about the live branch, not the receipt',
    );
    const afterFirst = await connector.messageStore.getByThreadIncludingQueued(threadId);

    await assert.rejects(
      () => deliverVisible(connector, threadId, { content: 'delete the production index' }),
      /identity conflict/i,
      'a live row must refuse a different envelope on its key, exactly as a retired one does',
    );

    assert.deepEqual(
      (await connector.messageStore.getByThreadIncludingQueued(threadId)).map((m) => m.id),
      afterFirst.map((m) => m.id),
      'the refusal must happen before any Message write, so no notice may appear',
    );
    assert.equal(connector.progressed.length, 1, 'and the conflicting envelope never starts work');
  });
});
